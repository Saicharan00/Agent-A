import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/bus';
import { ContainerManager } from '../../src/containers/manager';
import { FakeDocker } from './fake-docker';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('ContainerManager (fake docker)', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let docker: FakeDocker;
  let bus: EventBus;
  let events: unknown[];
  let clock: number;
  let manager: ContainerManager;
  let botId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-mgr-'));
    db = openDb(join(dir, 'test.db'));
    repos = createRepos(db);
    docker = new FakeDocker();
    bus = new EventBus();
    events = [];
    clock = 1_000_000;
    manager = new ContainerManager({
      docker,
      repos,
      bus,
      log: silent,
      botsDir: join(dir, 'bots'),
      sharedDir: join(dir, 'shared'),
      containerEnv: ['HTTPS_PROXY=http://proxy:3128'],
      healthPollMs: 1,
      healthTimeoutMs: 50,
      now: () => clock,
    });
    botId = repos.bots.create({ name: 'Code Reviewer', engine: 'mock', settings: { idleTimeoutMin: 30 } }).id;
    bus.subscribe(`bot:${botId}`, (e) => events.push(e));
  });

  afterEach(() => {
    manager.stopLoops();
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  const home = () => join(dir, 'bots', botId, 'home');

  it('start creates the container with limits, bootstraps the home and goes stopped → starting → running', async () => {
    const status = await manager.start(botId);
    expect(status).toMatchObject({ botId, status: 'running', health: 'healthy' });
    expect(status.novncPort).toBeGreaterThan(0);

    const bot = repos.bots.get(botId)!;
    expect(bot).toMatchObject({
      status: 'running',
      containerId: status.containerId,
      novncPort: status.novncPort,
    });
    expect(events).toEqual([
      { type: 'bot.status', botId, status: 'starting' },
      { type: 'bot.status', botId, status: 'running' },
    ]);

    const spec = docker.containers.get(status.containerId!)!.spec;
    expect(spec.name).toBe('agenta-bot-code-reviewer');
    expect(spec.labels).toEqual({ agenta: '1', 'agenta.bot': botId });
    expect(spec.memoryBytes).toBe(2048 * 1024 * 1024);
    expect(spec.nanoCpus).toBe(2e9);
    expect(spec.pidsLimit).toBe(512);
    expect(spec.capAdd).toEqual([]);
    expect(spec.binds).toEqual([`${home()}:/home/bot`, `${join(dir, 'shared')}:/shared`]);
    expect(spec.extraHosts).toEqual(['host.docker.internal:172.30.0.1']);
    expect(spec.env).toContain(`AGENTA_BOT_ID=${botId}`);
    expect(spec.env).toContain('HTTPS_PROXY=http://proxy:3128');

    for (const d of ['work', 'notes', '.claude', '.codex']) expect(existsSync(join(home(), d))).toBe(true);
    expect(readFileSync(join(home(), 'CLAUDE.md'), 'utf8')).toContain('rendered by Agent A');
    expect(existsSync(join(home(), 'AGENTS.md'))).toBe(true);
  });

  it('start is idempotent and does not overwrite an existing CLAUDE.md', async () => {
    await manager.start(botId);
    writeFileSync(join(home(), 'CLAUDE.md'), 'custom');
    await manager.stop(botId);
    await manager.start(botId);
    await manager.start(botId);
    expect(docker.calls.filter((c) => c.startsWith('create:'))).toHaveLength(1);
    expect(readFileSync(join(home(), 'CLAUDE.md'), 'utf8')).toBe('custom');
  });

  it('stop keeps the container and clears the port', async () => {
    const { containerId } = await manager.start(botId);
    const s = await manager.stop(botId);
    expect(s).toMatchObject({ status: 'stopped', containerId, novncPort: null });
    expect(repos.bots.get(botId)).toMatchObject({ status: 'stopped', containerId, novncPort: null });
    expect(events.at(-1)).toEqual({ type: 'bot.status', botId, status: 'stopped' });
  });

  it('reset(keep home) recreates the container and keeps files; a running computer comes back up', async () => {
    const first = await manager.start(botId);
    writeFileSync(join(home(), 'work', 'keep.txt'), 'hi');
    const after = await manager.reset(botId, { wipeHome: false });
    expect(after.status).toBe('running');
    expect(after.containerId).not.toBe(first.containerId);
    expect(docker.containers.has(first.containerId!)).toBe(false);
    expect(readFileSync(join(home(), 'work', 'keep.txt'), 'utf8')).toBe('hi');
  });

  it('reset(wipe) erases the home and re-bootstraps it on the next start', async () => {
    await manager.start(botId);
    await manager.stop(botId);
    writeFileSync(join(home(), 'work', 'gone.txt'), 'bye');
    const after = await manager.reset(botId, { wipeHome: true });
    expect(after).toMatchObject({ status: 'stopped', containerId: null });
    expect(existsSync(join(home(), 'work', 'gone.txt'))).toBe(false);
    await manager.start(botId);
    expect(existsSync(join(home(), 'work'))).toBe(true);
    expect(existsSync(join(home(), 'work', 'gone.txt'))).toBe(false);
  });

  it('exec starts the computer on demand and runs as bot', async () => {
    const h = await manager.exec(botId, { cmd: ['echo', 'hi'], env: { SECRET_TOKEN: 'x' } });
    let out = '';
    for await (const chunk of h.stdout) out += String(chunk);
    expect(await h.wait()).toBe(0);
    expect(out).toBe('ran echo hi\n');
    expect(repos.bots.get(botId)!.status).toBe('running');
    expect(docker.execs[0]!.opts).toMatchObject({ user: 'bot', env: { SECRET_TOKEN: 'x' } });
    // exec-only env never reaches the container definition
    const spec = [...docker.containers.values()][0]!.spec;
    expect(spec.env.join(' ')).not.toContain('SECRET_TOKEN');
  });

  it('marks the bot error when the desktop never becomes healthy', async () => {
    docker.startHealth = 'unhealthy';
    await expect(manager.start(botId)).rejects.toMatchObject({ code: 'start_failed' });
    expect(repos.bots.get(botId)!.status).toBe('error');
    expect(events.at(-1)).toMatchObject({ type: 'bot.status', status: 'error' });
  });

  it('times out a start that stays in health "starting"', async () => {
    docker.startHealth = 'starting';
    const pending = manager.start(botId);
    setTimeout(() => (clock += 60_000), 5);
    await expect(pending).rejects.toMatchObject({ code: 'start_timeout' });
  });

  it('fails clearly when the image is missing', async () => {
    docker.imagePresent = false;
    await expect(manager.start(botId)).rejects.toMatchObject({ code: 'image_missing', statusCode: 503 });
    expect(await manager.dockerHealth()).toEqual({ ok: true, version: '29.0.0-fake', image: false });
  });

  it('reports docker down in health', async () => {
    docker.down = true;
    expect(await manager.dockerHealth()).toMatchObject({
      ok: false,
      error: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('uses an id-suffixed name when the plain name is taken', async () => {
    const other = repos.bots.create({ name: 'Other', engine: 'mock' });
    await manager.ensureContainer(other.id);
    const taken = [...docker.containers.values()][0]!;
    taken.name = 'agenta-bot-code-reviewer';
    await manager.ensureContainer(botId);
    expect(docker.calls.at(-1)).toBe(`create:agenta-bot-code-reviewer-${botId.slice(-6).toLowerCase()}`);
  });

  it('unknown bot → bot_not_found', async () => {
    await expect(manager.start('bot_nope')).rejects.toMatchObject({ code: 'bot_not_found', statusCode: 404 });
  });

  describe('idle auto-stop', () => {
    it('stops after idleTimeoutMin without activity, not while busy', async () => {
      await manager.start(botId);
      clock += 29 * 60_000;
      expect(await manager.idleSweep()).toEqual([]);

      const release = manager.acquire(botId);
      clock += 60 * 60_000;
      expect(await manager.idleSweep()).toEqual([]); // lease held (run / terminal)
      release();

      clock += 29 * 60_000;
      expect(await manager.idleSweep()).toEqual([]); // release counts as activity
      clock += 2 * 60_000;
      expect(await manager.idleSweep()).toEqual([botId]);
      expect(repos.bots.get(botId)!.status).toBe('stopped');
    });

    it('idleTimeoutMin 0 never auto-stops', async () => {
      repos.bots.update(botId, { settings: { idleTimeoutMin: 0 } });
      await manager.start(botId);
      clock += 24 * 60 * 60_000;
      expect(await manager.idleSweep()).toEqual([]);
    });

    it('a TTY session holds the computer awake until its stream closes', async () => {
      const tty = await manager.execTty(botId, { cmd: ['bash'] });
      expect(manager.isBusy(botId)).toBe(true);
      tty.stream.destroy();
      await new Promise((r) => setImmediate(r));
      expect(manager.isBusy(botId)).toBe(false);
    });

    it('killTerminal signals the terminal processes as bot, and never starts a stopped computer', async () => {
      await manager.killTerminal(botId, 'trm_abc');
      expect(docker.execs).toHaveLength(0);
      expect(docker.calls.some((c) => c.startsWith('start:'))).toBe(false);

      await manager.start(botId);
      await manager.killTerminal(botId, 'trm_abc');
      const exec = docker.execs.at(-1)!;
      expect(exec.opts.user).toBe('bot');
      expect(exec.opts.cmd.slice(0, 2)).toEqual(['sh', '-c']);
      expect(exec.opts.cmd[2]).toContain('AGENTA_TERMINAL=$1');
      expect(exec.opts.cmd[3]).toBe('trm_abc');
      await expect(manager.killTerminal(botId, 'x; rm -rf /')).rejects.toThrow(/Bad terminal id/);
    });
  });

  describe('reconcile', () => {
    it('adopts labelled containers created before a runner restart', async () => {
      const id = docker.addExternal(botId, 'running');
      const report = await manager.reconcile();
      expect(report.adopted).toEqual([botId]);
      const bot = repos.bots.get(botId)!;
      expect(bot).toMatchObject({ status: 'running', containerId: id });
      expect(bot.novncPort).toBeGreaterThan(0);
    });

    it('marks bots stopped when their container stopped or vanished', async () => {
      const { containerId } = await manager.start(botId);
      await docker.stop(containerId!);
      await manager.reconcile();
      expect(repos.bots.get(botId)).toMatchObject({ status: 'stopped', containerId, novncPort: null });

      await docker.remove(containerId!);
      const report = await manager.reconcile();
      expect(report.cleared).toEqual([botId]);
      expect(repos.bots.get(botId)).toMatchObject({ status: 'stopped', containerId: null });
    });

    it('stops (but never removes) orphans whose bot no longer exists', async () => {
      const id = docker.addExternal('bot_deleted', 'running');
      const report = await manager.reconcile();
      expect(report.orphansStopped).toEqual([id]);
      expect(docker.containers.get(id)?.state).toBe('exited');
      expect(docker.calls).not.toContain(`remove:${id}`);
    });

    it('leaves non-bot agenta containers alone', async () => {
      docker.containers.set('net', {
        id: 'net',
        name: 'agenta-other',
        state: 'running',
        health: 'none',
        labels: { agenta: '1' },
        hostPort: null,
        spec: {} as never,
      });
      await manager.reconcile();
      expect(docker.containers.get('net')?.state).toBe('running');
    });
  });
});
