import type { Bot, Repos } from '@agenta/db';
import {
  type BotCreateRequest,
  type BotUpdateRequest,
  type BotView,
  type LiveBotsChanged,
  botCreateRequestSchema,
  botUpdateRequestSchema,
} from '@agenta/shared';
import type { EventBus } from '../bus';
import { bootstrapHome, botHomeDir, removeBotDir } from '../containers/home';
import type { ContainerManager } from '../containers/manager';
import type { RunService } from '../runs/service';
import { ensureMcpToken } from './mcp-token';

type Log = { info(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };

export class BotError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type BotServiceOptions = {
  repos: Repos;
  bus: EventBus;
  log: Log;
  botsDir: string;
  /** Absent when Docker is disabled: no containers to stop or remove. */
  containers?: ContainerManager;
  /** Absent in tests that don't run anything: no runs to cancel. */
  runs?: Pick<RunService, 'cancel'>;
};

/** Settings fields baked into the container at create time (see ContainerManager.discardStale). */
function specChanged(before: Bot, after: Bot): boolean {
  return (
    before.slug !== after.slug ||
    before.settings.cpus !== after.settings.cpus ||
    before.settings.memoryMb !== after.settings.memoryMb
  );
}

/**
 * Bot management (PLAN F12). Creating a bot writes the row, its DM thread, its home folder and its Platform MCP
 * token; the container itself is created lazily on first use. Archive keeps everything; delete removes the row
 * (cascading runs, sessions, memories…), the bot's DM threads, its container and optionally its home folder.
 */
export class BotService {
  constructor(private readonly opts: BotServiceOptions) {}

  view(bot: Bot, activity = this.opts.repos.runs.lastActivityByBot()): BotView {
    const { containerId: _c, novncPort: _p, mcpTokenHash: _h, ...rest } = bot;
    return {
      ...rest,
      dmThreadId: this.opts.repos.threads.findDm(bot.id)?.id ?? null,
      lastActivityAt: activity.get(bot.id) ?? null,
    };
  }

  list(archived: 'exclude' | 'include' | 'only'): BotView[] {
    const activity = this.opts.repos.runs.lastActivityByBot();
    const rows = this.opts.repos.bots.list({ includeArchived: archived !== 'exclude' });
    return rows
      .filter((b) => archived !== 'only' || b.archivedAt !== null)
      .sort((a, b) => Number(b.isLead) - Number(a.isLead))
      .map((b) => this.view(b, activity));
  }

  get(id: string): Bot {
    const bot = this.opts.repos.bots.get(id);
    if (!bot) throw new BotError('bot_not_found', `Bot ${id} not found`, 404);
    return bot;
  }

  create(input: BotCreateRequest): Bot {
    const data = botCreateRequestSchema.parse(input);
    const { repos } = this.opts;
    if (data.slug && repos.bots.getBySlug(data.slug)) {
      throw new BotError('slug_taken', `The handle @${data.slug} is already used by another bot`, 409);
    }
    const bot = repos.bots.create(data);
    repos.threads.create({ kind: 'dm', title: bot.name, memberBotIds: [bot.id] });
    this.provision(bot.id);
    this.opts.log.info({ botId: bot.id, engine: bot.engine }, 'bot created');
    this.changed(bot.id, 'created');
    return repos.bots.get(bot.id)!;
  }

  /** Returns the bot and whether its running computer must restart to apply the change. */
  async update(id: string, input: BotUpdateRequest): Promise<{ bot: Bot; restartRequired: boolean }> {
    const patch = botUpdateRequestSchema.parse(input);
    const before = this.get(id);
    const { repos } = this.opts;
    if (patch.slug !== undefined && patch.slug !== before.slug && repos.bots.getBySlug(patch.slug)) {
      throw new BotError('slug_taken', `The handle @${patch.slug} is already used by another bot`, 409);
    }
    const bot = repos.bots.update(id, patch)!;
    // Keep the DM thread's title in step with the bot's name.
    if (patch.name !== undefined && patch.name !== before.name) {
      const dm = repos.threads.findDm(id);
      if (dm) repos.threads.update(dm.id, { title: bot.name });
    }
    let restartRequired = false;
    if (specChanged(before, bot) && this.opts.containers) {
      restartRequired = await this.opts.containers.discardStale(id).catch((err: unknown) => {
        // Docker down: the stale container is replaced the next time it is reset.
        this.opts.log.warn({ botId: id, err: (err as Error).message }, 'could not refresh bot container');
        return before.containerId !== null;
      });
    }
    this.changed(id, 'updated');
    return { bot, restartRequired };
  }

  /** Stops active work and the computer, then hides the bot. Data (threads, home, memories) is kept. */
  async archive(id: string): Promise<Bot> {
    const bot = this.get(id);
    if (bot.isLead) throw new BotError('lead_protected', 'Agent A (the lead) cannot be archived', 409);
    if (bot.archivedAt) return bot;
    const archived = this.opts.repos.bots.archive(id)!; // first, so nothing new is queued meanwhile
    await this.cancelRuns(id);
    if (this.opts.containers) {
      await this.opts.containers.stop(id).catch((err: unknown) => {
        this.opts.log.warn(
          { botId: id, err: (err as Error).message },
          'could not stop archived bot computer',
        );
      });
    }
    this.opts.log.info({ botId: id }, 'bot archived');
    this.changed(id, 'archived');
    return this.opts.repos.bots.get(id) ?? archived;
  }

  restore(id: string): Bot {
    const bot = this.get(id);
    if (!bot.archivedAt) return bot;
    const restored = this.opts.repos.bots.unarchive(id)!;
    if (!this.opts.repos.threads.findDm(id)) {
      this.opts.repos.threads.create({ kind: 'dm', title: restored.name, memberBotIds: [id] });
    }
    this.opts.log.info({ botId: id }, 'bot restored');
    this.changed(id, 'restored');
    return restored;
  }

  /** Permanent. The caller must pass the bot's exact name (the UI makes the user type it). */
  async delete(id: string, opts: { confirmName: string; deleteHome: boolean }): Promise<void> {
    const bot = this.get(id);
    if (bot.isLead) throw new BotError('lead_protected', 'Agent A (the lead) cannot be deleted', 409);
    if (opts.confirmName !== bot.name) {
      throw new BotError('confirm_mismatch', `Type the bot's name (${bot.name}) to delete it`, 400);
    }
    const { repos } = this.opts;
    // Archive first so nothing new is queued while runs are cancelled and the container is removed.
    if (!bot.archivedAt) repos.bots.archive(id);
    await this.cancelRuns(id);
    if (this.opts.containers) {
      try {
        await this.opts.containers.destroy(id);
      } catch (err) {
        // Leave the bot archived rather than orphaning a container the runner can no longer map to a bot.
        throw new BotError(
          'docker_unavailable',
          `Could not remove the bot's computer: ${(err as Error).message}`,
          503,
        );
      }
    }
    for (const t of repos.threads.list({ kind: 'dm', botId: id, includeArchived: true })) {
      repos.threads.delete(t.id);
    }
    repos.bots.delete(id);
    if (opts.deleteHome) removeBotDir(this.opts.botsDir, id);
    this.opts.log.info({ botId: id, deleteHome: opts.deleteHome }, 'bot deleted');
    this.changed(id, 'deleted');
  }

  /** A new bot with the same profile and settings (fresh slug, DM thread, home and token; no history). */
  duplicate(id: string, name?: string): Bot {
    const src = this.get(id);
    const copyName = name ?? `${src.name} (copy)`.slice(0, 64);
    return this.create({
      name: copyName,
      slug: undefined,
      role: src.role,
      instructions: src.instructions,
      engine: src.engine,
      model: src.model,
      avatarColor: src.avatarColor,
      avatarShape: src.avatarShape,
      settings: src.settings,
      sidebarVisible: src.sidebarVisible,
      notifications: src.notifications,
    });
  }

  /** Home folder + MCP token. Also safe to call later (e.g. after a home wipe). */
  provision(id: string): void {
    bootstrapHome(botHomeDir(this.opts.botsDir, id));
    ensureMcpToken(this.opts.repos, this.opts.botsDir, id);
  }

  private async cancelRuns(botId: string): Promise<void> {
    const runs = this.opts.runs;
    if (!runs) return;
    const active = this.opts.repos.runs.list({ botId, status: ['queued', 'running'], limit: 500 });
    await Promise.all(
      active.map((r) =>
        runs.cancel(r.id).catch((err: unknown) => {
          this.opts.log.warn({ runId: r.id, err: (err as Error).message }, 'could not cancel run');
        }),
      ),
    );
  }

  private changed(botId: string, change: LiveBotsChanged['change']): void {
    this.opts.bus.publish('global', { type: 'bots.changed', botId, change } satisfies LiveBotsChanged);
  }
}
