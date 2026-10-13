import type { Bot, Repos } from '@agenta/db';
import {
  BOT_IMAGE,
  BOT_NETWORK,
  type BotStatus,
  type BotStatusEvent,
  type ComputerStatus,
} from '@agenta/shared';
import type { EventBus } from '../bus';
import {
  type ContainerInfo,
  type DockerApi,
  type ExecHandle,
  type ExecOptions,
  type TtyHandle,
  dockerStatus,
} from './docker';
import { botHomeDir, bootstrapHome, checkSymlinks, ensureSharedLayout, wipeHome } from './home';
import { BOT_LABEL, buildContainerSpec, statusFromContainer } from './spec';

type Log = {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

export class ContainerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type ManagerOptions = {
  docker: DockerApi;
  repos: Pick<Repos, 'bots'>;
  bus: EventBus;
  log: Log;
  botsDir: string;
  sharedDir: string;
  /** Extra container env (proxy settings). Never secrets: these show up in `docker inspect`. */
  containerEnv?: string[];
  /**
   * Runs before a container starts, with the bot's home on the host (F06: copies the Codex login in).
   * A failure is logged and the start continues: engines report their own auth errors.
   */
  prepareHome?: (botId: string, home: string) => Promise<void>;
  image?: string;
  network?: string;
  stopTimeoutSec?: number;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  reconcileIntervalMs?: number;
  idleCheckIntervalMs?: number;
  now?: () => number;
};

export type ReconcileReport = { adopted: string[]; orphansStopped: string[]; cleared: string[] };

export class ContainerManager {
  private readonly docker: DockerApi;
  private readonly image: string;
  private readonly network: string;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly leases = new Map<string, Set<symbol>>();
  private readonly lastActivity = new Map<string, number>();
  private gateway: string | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: ManagerOptions) {
    this.docker = opts.docker;
    this.image = opts.image ?? BOT_IMAGE;
    this.network = opts.network ?? BOT_NETWORK;
    this.now = opts.now ?? Date.now;
  }

  // ---------- health ----------

  /** The bot network's gateway IP (host.docker.internal inside bots), creating the network if missing. */
  async networkGateway(): Promise<string> {
    this.gateway ??= await this.docker.ensureNetwork(this.network, { agenta: '1' });
    return this.gateway;
  }

  async dockerHealth(): Promise<{ ok: boolean; version?: string; image?: boolean; error?: string }> {
    try {
      const version = await this.docker.version();
      return { ok: true, version, image: await this.docker.imageExists(this.image) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ---------- lifecycle ----------

  async status(botId: string): Promise<ComputerStatus> {
    const bot = this.requireBot(botId);
    const c = await this.findContainer(bot);
    return {
      botId,
      status: bot.status,
      containerId: c?.id ?? null,
      novncPort: c?.state === 'running' ? c.hostPort : null,
      health: c?.state === 'running' ? c.health : null,
    };
  }

  /** Creates the bot's container (not started) if it doesn't exist yet. */
  async ensureContainer(botId: string): Promise<ContainerInfo> {
    return this.withLock(botId, () => this.ensureContainerUnlocked(this.requireBot(botId)));
  }

  async start(botId: string): Promise<ComputerStatus> {
    await this.withLock(botId, () => this.startUnlocked(this.requireBot(botId)));
    return this.status(botId);
  }

  async stop(botId: string): Promise<ComputerStatus> {
    await this.withLock(botId, async () => {
      const bot = this.requireBot(botId);
      const c = await this.findContainer(bot);
      if (c && c.state !== 'exited' && c.state !== 'created') {
        await this.docker.stop(c.id, this.opts.stopTimeoutSec ?? 10);
      }
      this.setStatus(bot, 'stopped', { containerId: c?.id ?? null, novncPort: null });
      this.lastActivity.delete(botId);
    });
    return this.status(botId);
  }

  /**
   * Destroys the container (the next start creates a fresh one from the current image).
   * `wipeHome` also erases /home/bot. A running computer is started again afterwards.
   */
  async reset(botId: string, opts: { wipeHome: boolean }): Promise<ComputerStatus> {
    await this.withLock(botId, async () => {
      const bot = this.requireBot(botId);
      const c = await this.findContainer(bot);
      const wasRunning = c?.state === 'running';
      if (c) await this.docker.remove(c.id);
      if (opts.wipeHome) {
        wipeHome(this.opts.botsDir, botHomeDir(this.opts.botsDir, botId));
        this.opts.log.warn({ botId }, 'bot home wiped');
      }
      this.setStatus(bot, 'stopped', { containerId: null, novncPort: null });
      this.opts.log.info({ botId, wipeHome: opts.wipeHome }, 'bot computer reset');
      if (wasRunning) await this.startUnlocked(this.requireBot(botId));
    });
    return this.status(botId);
  }

  /**
   * Removes the bot's container for good (bot deleted). The home folder is left alone; see `removeBotDir`.
   * Safe when there is no container or Docker never created one.
   */
  async destroy(botId: string): Promise<void> {
    await this.withLock(botId, async () => {
      const bot = this.opts.repos.bots.get(botId);
      if (!bot) return;
      const c = await this.findContainer(bot);
      if (c) await this.docker.remove(c.id);
      this.lastActivity.delete(botId);
      this.setStatus(bot, 'stopped', { containerId: null, novncPort: null });
      if (c) this.opts.log.info({ botId, containerId: c.id }, 'bot container removed');
    });
  }

  /**
   * The container's name and resource limits are fixed at create time. After a bot's slug or limits change, a
   * stopped container is removed so the next start recreates it (the home folder is kept). A running one is
   * left alone; returns true when it must be restarted (Reset) to pick up the change.
   */
  async discardStale(botId: string): Promise<boolean> {
    return this.withLock(botId, async () => {
      const bot = this.requireBot(botId);
      const c = await this.findContainer(bot);
      if (!c) return false;
      if (c.state === 'running' || c.state === 'restarting') return true;
      await this.docker.remove(c.id);
      this.setStatus(bot, 'stopped', { containerId: null, novncPort: null });
      this.opts.log.info(
        { botId, containerId: c.id },
        'stale bot container removed (recreated on next start)',
      );
      return false;
    });
  }

  /** Starts the computer on demand; returns its running container. */
  async ensureRunning(botId: string): Promise<ContainerInfo> {
    const bot = this.requireBot(botId);
    const c = await this.findContainer(bot);
    if (c && c.state === 'running' && bot.status === 'running') return c;
    return this.withLock(botId, () => this.startUnlocked(this.requireBot(botId)));
  }

  /** Runs a command in the bot's container (started on demand). stdout/stderr are demultiplexed. */
  async exec(botId: string, opts: ExecOptions): Promise<ExecHandle> {
    const c = await this.ensureRunning(botId);
    this.touch(botId);
    const release = this.acquire(botId);
    const handle = await this.docker.exec(c.id, { user: 'bot', ...opts }).catch((err: unknown) => {
      release();
      throw err;
    });
    return {
      ...handle,
      wait: async () => {
        try {
          return await handle.wait();
        } finally {
          release();
        }
      },
    };
  }

  /** Interactive TTY exec (terminals, F14). The computer stays awake while the terminal is attached. */
  async execTty(botId: string, opts: ExecOptions & { cols?: number; rows?: number }): Promise<TtyHandle> {
    const c = await this.ensureRunning(botId);
    this.touch(botId);
    const release = this.acquire(botId);
    try {
      const tty = await this.docker.execTty(c.id, { user: 'bot', ...opts });
      tty.stream.once('close', release);
      return tty;
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * Ends every process of a terminal (its shell and whatever it started). Docker keeps a TTY exec alive after the
   * client hangs up, so the terminal's processes carry `AGENTA_TERMINAL=<id>` in their environment and this
   * HUPs (then, a second later, KILLs) each of them. Never starts a stopped computer: nothing to kill there.
   */
  async killTerminal(botId: string, terminalId: string): Promise<void> {
    if (!/^[\w-]+$/.test(terminalId)) throw new Error(`Bad terminal id ${terminalId}`);
    const bot = this.opts.repos.bots.get(botId);
    const c = bot && (await this.findContainer(bot));
    if (!c || c.state !== 'running') return;
    const script =
      'k(){ for d in /proc/[0-9]*; do grep -qxzF "AGENTA_TERMINAL=$1" "$d/environ" 2>/dev/null' +
      ' && kill -"$2" "${d#/proc/}" 2>/dev/null; done; }; k "$0" HUP; sleep 1; k "$0" KILL; exit 0';
    const h = await this.docker.exec(c.id, { user: 'bot', cmd: ['sh', '-c', script, terminalId] });
    h.stdout.resume();
    h.stderr.resume();
    await h.wait();
  }

  // ---------- activity & idle auto-stop ----------

  /** Marks the bot busy (run in progress, terminal attached). Call the returned function when done. */
  acquire(botId: string): () => void {
    const token = Symbol(botId);
    const set = this.leases.get(botId) ?? new Set<symbol>();
    set.add(token);
    this.leases.set(botId, set);
    this.touch(botId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set.delete(token);
      if (set.size === 0) this.leases.delete(botId);
      this.touch(botId);
    };
  }

  touch(botId: string): void {
    this.lastActivity.set(botId, this.now());
  }

  isBusy(botId: string): boolean {
    return (this.leases.get(botId)?.size ?? 0) > 0;
  }

  /** Stops running computers that have been idle longer than their bot's idleTimeoutMin (0 = never). */
  async idleSweep(): Promise<string[]> {
    const stopped: string[] = [];
    for (const bot of this.opts.repos.bots.list()) {
      if (bot.status !== 'running' || this.isBusy(bot.id) || this.locks.has(bot.id)) continue;
      const timeoutMs = bot.settings.idleTimeoutMin * 60_000;
      if (timeoutMs <= 0) continue;
      const last = this.lastActivity.get(bot.id);
      if (last === undefined) {
        this.touch(bot.id); // first sighting (e.g. adopted after a runner restart): start the clock now
        continue;
      }
      if (this.now() - last < timeoutMs) continue;
      this.opts.log.info(
        { botId: bot.id, idleMin: bot.settings.idleTimeoutMin },
        'stopping idle bot computer',
      );
      await this.stop(bot.id);
      stopped.push(bot.id);
    }
    return stopped;
  }

  // ---------- reconcile ----------

  /** Aligns DB status with Docker: adopts labelled containers, stops orphans, clears vanished ones. */
  async reconcile(): Promise<ReconcileReport> {
    const report: ReconcileReport = { adopted: [], orphansStopped: [], cleared: [] };
    const containers = await this.docker.list({ agenta: '1', [BOT_LABEL]: '' });
    const bots = new Map(this.opts.repos.bots.list({ includeArchived: true }).map((b) => [b.id, b]));
    const seen = new Set<string>();

    for (const c of containers) {
      const botId = c.labels[BOT_LABEL] ?? '';
      const bot = bots.get(botId);
      if (!bot || seen.has(botId)) {
        // Orphan (bot deleted) or duplicate: stop only, never delete (PLAN F05).
        if (c.state === 'running') {
          await this.docker.stop(c.id, this.opts.stopTimeoutSec ?? 10);
          report.orphansStopped.push(c.id);
        }
        this.opts.log.warn(
          { containerId: c.id, name: c.name, botId },
          'orphan bot container (stopped, not removed)',
        );
        continue;
      }
      seen.add(botId);
      if (this.locks.has(botId)) continue; // a lifecycle operation is in flight
      const status = statusFromContainer(c);
      const novncPort = c.state === 'running' ? c.hostPort : null;
      if (bot.containerId !== c.id) report.adopted.push(botId);
      if (bot.containerId !== c.id || bot.status !== status || bot.novncPort !== novncPort) {
        this.setStatus(bot, status, { containerId: c.id, novncPort });
      }
    }

    for (const bot of bots.values()) {
      if (seen.has(bot.id) || this.locks.has(bot.id)) continue;
      if (bot.containerId !== null || bot.status !== 'stopped' || bot.novncPort !== null) {
        this.setStatus(bot, 'stopped', { containerId: null, novncPort: null });
        report.cleared.push(bot.id);
      }
    }
    if (report.adopted.length || report.orphansStopped.length || report.cleared.length) {
      this.opts.log.info(report, 'containers reconciled');
    }
    return report;
  }

  /** Reconcile now and every `reconcileIntervalMs` (default 60 s); idle sweep every `idleCheckIntervalMs`. */
  startLoops(): void {
    const reconcile = () =>
      this.reconcile().catch((err: unknown) => this.opts.log.warn({ err }, 'reconcile failed'));
    const sweep = () =>
      this.idleSweep().catch((err: unknown) => this.opts.log.warn({ err }, 'idle sweep failed'));
    void reconcile();
    this.timers.push(setInterval(reconcile, this.opts.reconcileIntervalMs ?? 60_000));
    this.timers.push(setInterval(sweep, this.opts.idleCheckIntervalMs ?? 60_000));
    for (const t of this.timers) t.unref();
  }

  stopLoops(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ---------- internals ----------

  private requireBot(botId: string): Bot {
    const bot = this.opts.repos.bots.get(botId);
    if (!bot) throw new ContainerError('bot_not_found', `Bot ${botId} not found`, 404);
    return bot;
  }

  private async withLock<T>(botId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(botId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(botId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(botId) === tail) this.locks.delete(botId);
    }
  }

  private async findContainer(bot: Bot): Promise<ContainerInfo | null> {
    if (bot.containerId) {
      const c = await this.docker.inspect(bot.containerId);
      if (c) return c;
    }
    const found = await this.docker.list({ agenta: '1', [BOT_LABEL]: bot.id });
    return found[0] ?? null;
  }

  private async ensureContainerUnlocked(bot: Bot): Promise<ContainerInfo> {
    const existing = await this.findContainer(bot);
    if (existing) {
      if (bot.containerId !== existing.id)
        this.opts.repos.bots.updateRuntime(bot.id, { containerId: existing.id });
      return existing;
    }
    if (!(await this.docker.imageExists(this.image))) {
      throw new ContainerError(
        'image_missing',
        `Image ${this.image} not found. Run \`pnpm image:build\`.`,
        503,
      );
    }
    const home = botHomeDir(this.opts.botsDir, bot.id);
    for (const dir of [this.opts.botsDir, this.opts.sharedDir]) {
      const problem = checkSymlinks(dir);
      if (problem) throw new ContainerError('storage_unsupported', problem, 503);
    }
    if (bootstrapHome(home)) this.opts.log.info({ botId: bot.id, home }, 'bot home created');
    ensureSharedLayout(this.opts.sharedDir);

    const specOpts = {
      bot,
      home,
      sharedDir: this.opts.sharedDir,
      gateway: await this.networkGateway(),
      env: this.opts.containerEnv ?? [],
      image: this.image,
      network: this.network,
    };
    let id: string;
    try {
      id = await this.docker.create(buildContainerSpec(specOpts));
    } catch (err) {
      if (dockerStatus(err) !== 409) throw err;
      // Name taken (e.g. an orphan from a deleted bot with the same slug): use an id-suffixed name.
      id = await this.docker.create(buildContainerSpec({ ...specOpts, nameSuffix: true }));
    }
    this.opts.repos.bots.updateRuntime(bot.id, { containerId: id });
    this.opts.log.info({ botId: bot.id, containerId: id }, 'bot container created');
    const info = await this.docker.inspect(id);
    if (!info) throw new ContainerError('container_missing', `Container ${id} vanished after create`, 500);
    return info;
  }

  private async startUnlocked(bot: Bot): Promise<ContainerInfo> {
    const created = await this.ensureContainerUnlocked(bot);
    if (created.state === 'running' && created.health !== 'starting' && created.health !== 'unhealthy') {
      this.setStatus(bot, 'running', { containerId: created.id, novncPort: created.hostPort });
      this.touch(bot.id);
      return created;
    }
    this.setStatus(bot, 'starting', { containerId: created.id });
    try {
      await this.opts.prepareHome?.(bot.id, botHomeDir(this.opts.botsDir, bot.id)).catch((err: unknown) => {
        this.opts.log.warn({ botId: bot.id, err: (err as Error).message }, 'prepareHome failed');
      });
      await this.docker.start(created.id);
      const ready = await this.waitHealthy(created.id);
      this.setStatus(bot, 'running', { containerId: ready.id, novncPort: ready.hostPort });
      this.touch(bot.id);
      return ready;
    } catch (err) {
      this.setStatus(bot, 'error', { novncPort: null }, (err as Error).message);
      throw err instanceof ContainerError
        ? err
        : new ContainerError('start_failed', `Could not start the computer: ${(err as Error).message}`, 500);
    }
  }

  private async waitHealthy(id: string): Promise<ContainerInfo> {
    const deadline = this.now() + (this.opts.healthTimeoutMs ?? 60_000);
    const poll = this.opts.healthPollMs ?? 500;
    for (;;) {
      const c = await this.docker.inspect(id);
      if (!c)
        throw new ContainerError('container_missing', `Container ${id} disappeared while starting`, 500);
      if (c.state === 'running' && (c.health === 'healthy' || c.health === 'none')) return c;
      if (c.state === 'exited' || c.state === 'dead' || c.health === 'unhealthy') {
        throw new ContainerError(
          'start_failed',
          `Computer failed to start (state ${c.state}, health ${c.health})`,
          500,
        );
      }
      if (this.now() > deadline) {
        throw new ContainerError('start_timeout', 'Computer did not become healthy in time', 504);
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  private setStatus(
    bot: Bot,
    status: BotStatus,
    runtime: { containerId?: string | null; novncPort?: number | null } = {},
    message?: string,
  ): void {
    const changed = bot.status !== status;
    const updated = this.opts.repos.bots.updateRuntime(bot.id, { status, ...runtime });
    if (updated) Object.assign(bot, updated);
    if (changed) {
      const event: BotStatusEvent = {
        type: 'bot.status',
        botId: bot.id,
        status,
        ...(message ? { message } : {}),
      };
      this.opts.bus.publish(`bot:${bot.id}`, event);
      this.opts.log.info({ botId: bot.id, status }, 'bot status');
    }
  }
}
