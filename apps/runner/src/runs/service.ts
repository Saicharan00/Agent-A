import type { Bot, Repos, Run } from '@agenta/db';
import type {
  Engine,
  EngineEvent,
  LiveMessage,
  LiveRunUpdated,
  RunFinishStatus,
  RunTrigger,
  RunUsage,
} from '@agenta/shared';
import type { EventBus } from '../bus';
import type { Log } from '../engines/cli';
import { CONTAINER_HOME } from '../engines/process';
import { buildSystemPromptAppend } from '../engines/prompt';
import type { EngineRegistry } from '../engines/registry';
import type { EngineRunInput } from '../engines/types';
import { RunEventWriter } from './events';

// The run orchestrator (F10): every bot turn is a `runs` row that a single in-process scheduler moves
// queued → running → finished. Runs are owned by the runner, not the browser: events are persisted to
// run_events and published on the bus, and the bot's reply is written to its thread as it arrives.

export const DEFAULT_MAX_CONCURRENT_RUNS = 2;
/** settings key for the global concurrency cap (a positive integer). */
export const MAX_CONCURRENT_SETTING = 'maxConcurrentRuns';
export const MCP_CONFIG_PATH = `${CONTAINER_HOME}/.agenta/mcp.json`;
export const WORK_DIR = `${CONTAINER_HOME}/work`;

export class RunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type EnqueueInput = {
  botId: string;
  threadId?: string | null;
  taskId?: string | null;
  trigger: RunTrigger;
  prompt: string;
  parentRunId?: string | null;
  hopCount?: number;
};

/**
 * Gets the bot's computer ready for a turn (container running, instruction files rendered) and keeps it awake.
 * Returns a function that releases it when the run ends.
 */
export type PrepareComputer = (bot: Bot, engine: Engine) => Promise<() => void>;

export type RunServiceOptions = {
  repos: Repos;
  bus: EventBus;
  engines: EngineRegistry;
  log: Log & { error(obj: object, msg?: string): void };
  prepare?: PrepareComputer;
  now?: () => Date;
  /** Event batching window. Default 50 ms; 0 writes every event at once. */
  flushMs?: number;
  /** Safety-net scheduler tick (limits expiring, missed wake-ups). Default 5 s. */
  pollMs?: number;
};

type Active = { run: Run; controller: AbortController; done: Promise<void> };

/** Per-attempt bookkeeping while an engine streams. */
type Turn = {
  texts: string[];
  messageId?: string;
  usage: RunUsage;
  hasUsage: boolean;
  lastError?: string;
  sessionId?: string;
  engineStatus?: RunFinishStatus;
};

export class RunService {
  private readonly active = new Map<string, Active>();
  private readonly now: () => Date;
  private scheduled = false;
  private stopped = false;
  private poll: NodeJS.Timeout | undefined;

  constructor(private readonly opts: RunServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  // ---------- queue ----------

  /** Creates a `queued` run for the bot's effective engine and wakes the scheduler. */
  enqueue(input: EnqueueInput): Run {
    const { repos, engines } = this.opts;
    const bot = repos.bots.get(input.botId);
    if (!bot) throw new RunError('bot_not_found', `Bot ${input.botId} not found`, 404);
    if (bot.archivedAt) throw new RunError('bot_archived', `${bot.name} is archived`, 409);
    const run = repos.runs.create({ ...input, engine: engines.effectiveEngine(bot) });
    this.opts.log.info({ runId: run.id, botId: bot.id, trigger: run.trigger }, 'run queued');
    this.publishRun(run);
    this.schedule();
    return run;
  }

  /** Runs currently executing in this process. */
  activeRunIds(): string[] {
    return [...this.active.keys()];
  }

  /** Resolves when the run (if executing here) has finished and been recorded. */
  async settled(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  /** Resolves once nothing is executing and nothing startable is queued. Test helper. */
  async idle(): Promise<void> {
    for (;;) {
      this.tick();
      const running = [...this.active.values()].map((a) => a.done);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  // ---------- scheduler ----------

  start(): void {
    this.stopped = false;
    this.poll ??= setInterval(() => this.tick(), this.opts.pollMs ?? 5000);
    this.poll.unref();
    this.schedule();
  }

  /** Stops scheduling. Runs still executing are left alone (see shutdown in session 2). */
  stop(): void {
    this.stopped = true;
    clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Coalesces wake-ups (enqueue, finish) into one tick on the next turn of the event loop. */
  schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  maxConcurrent(): number {
    const v = this.opts.repos.settings.get<unknown>(MAX_CONCURRENT_SETTING);
    return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : DEFAULT_MAX_CONCURRENT_RUNS;
  }

  /**
   * Starts queued runs FIFO while respecting: the global cap, one running run per bot (its later turns wait)
   * and engines paused by a usage limit. Synchronous, so two ticks can never pick the same run.
   */
  tick(): void {
    if (this.stopped) return;
    const { repos } = this.opts;
    const max = this.maxConcurrent();
    if (this.active.size >= max) return;
    const busyBots = new Set([...this.active.values()].map((a) => a.run.botId));
    const nowIso = this.now().toISOString();
    const limited = new Map<Engine, boolean>();
    const isLimited = (e: Engine) => {
      if (!limited.has(e)) limited.set(e, repos.engineState.isLimited(e, nowIso));
      return limited.get(e)!;
    };
    for (const queued of repos.runs.listQueued()) {
      if (this.active.size >= max) break;
      if (busyBots.has(queued.botId) || isLimited(queued.engine)) continue;
      const run = repos.runs.markRunning(queued.id);
      if (!run) continue; // cancelled meanwhile
      busyBots.add(run.botId);
      const controller = new AbortController();
      const active: Active = { run, controller, done: Promise.resolve() };
      this.active.set(run.id, active);
      this.publishRun(run);
      active.done = this.execute(run, controller.signal)
        .catch((err: unknown) => {
          // Only reachable if recording the outcome itself failed (e.g. the run row was deleted).
          this.opts.log.error({ runId: run.id, err: (err as Error).message }, 'could not record run outcome');
        })
        .finally(() => {
          this.active.delete(run.id);
          this.schedule();
        });
    }
  }

  // ---------- execution ----------

  private async execute(run: Run, signal: AbortSignal): Promise<void> {
    const { repos, log } = this.opts;
    const writer = new RunEventWriter(repos.runs, this.opts.bus, run.id, this.opts.flushMs);
    const turn: Turn = { texts: [], usage: {}, hasUsage: false };
    let release: (() => void) | undefined;
    log.info({ runId: run.id, botId: run.botId, engine: run.engine }, 'run started');
    try {
      const bot = repos.bots.get(run.botId);
      if (!bot) throw new Error('The bot was deleted');
      release = await this.opts.prepare?.(bot, run.engine);
      const adapter = this.opts.engines.get({ engine: run.engine });
      for await (const event of adapter.run(this.buildInput(run, bot), signal)) {
        this.onEvent(run, event, turn, writer);
      }
    } catch (err) {
      const message = (err as Error).message;
      log.warn({ runId: run.id, err: message }, 'run crashed');
      if (!signal.aborted) {
        turn.lastError = message;
        writer.push({ type: 'error', message });
      }
    } finally {
      release?.();
    }

    const status = turn.engineStatus ?? (signal.aborted ? 'cancelled' : 'failed');
    const error =
      status === 'failed'
        ? (turn.lastError ??
          (turn.engineStatus ? 'The engine reported a failure' : 'The engine ended without a result'))
        : null;
    writer.push({ type: 'run.finished', status, ...(turn.sessionId ? { sessionId: turn.sessionId } : {}) });
    writer.flush();
    this.saveSession(run, turn.sessionId);
    const finished = repos.runs.finish(run.id, {
      status,
      error,
      ...(turn.hasUsage ? { usage: turn.usage } : {}),
    });
    log.info({ runId: run.id, status, error }, 'run finished');
    if (finished) this.publishRun(finished);
  }

  private buildInput(run: Run, bot: Bot): EngineRunInput {
    const { repos } = this.opts;
    const thread = run.threadId ? (repos.threads.get(run.threadId) ?? null) : null;
    const session = thread ? repos.sessions.get(bot.id, thread.id) : undefined;
    // A session from another engine can't be resumed (the bot switched engines).
    const resumeSessionId =
      session && session.engine === run.engine ? (session.engineSessionId ?? undefined) : undefined;
    return {
      bot,
      threadId: run.threadId ?? run.id,
      prompt: run.prompt,
      systemPromptAppend: buildSystemPromptAppend(bot, thread),
      ...(resumeSessionId ? { resumeSessionId } : {}),
      mcpConfigPath: MCP_CONFIG_PATH,
      cwd: WORK_DIR,
    };
  }

  private onEvent(run: Run, event: EngineEvent, turn: Turn, writer: RunEventWriter): void {
    switch (event.type) {
      case 'run.finished':
        // The orchestrator writes the run's single run.finished itself, once the final status is known.
        turn.engineStatus = event.status;
        if (event.sessionId) turn.sessionId = event.sessionId;
        return;
      case 'run.started':
        if (event.sessionId) {
          turn.sessionId = event.sessionId;
          this.saveSession(run, event.sessionId);
        }
        break;
      case 'usage':
        turn.hasUsage = true;
        for (const k of ['inputTokens', 'outputTokens', 'costUsdEquivalent'] as const) {
          if (event[k] !== undefined) turn.usage[k] = (turn.usage[k] ?? 0) + event[k];
        }
        break;
      case 'error':
        turn.lastError = event.message;
        break;
    }
    writer.push(event);
    if (event.type === 'text.final') this.appendReply(run, event.text, turn);
  }

  /** The bot's reply in the thread: one message per run, extended by each complete assistant message. */
  private appendReply(run: Run, text: string, turn: Turn): void {
    if (!run.threadId || !text.trim()) return;
    const { repos } = this.opts;
    turn.texts.push(text.trim());
    const contentMd = turn.texts.join('\n\n');
    const msg = turn.messageId
      ? repos.messages.updateContent(turn.messageId, contentMd)
      : repos.messages.create({
          threadId: run.threadId,
          authorType: 'bot',
          authorBotId: run.botId,
          contentMd,
          runId: run.id,
        });
    if (!msg) return;
    const created = !turn.messageId;
    turn.messageId = msg.id;
    const live: LiveMessage = {
      type: created ? 'message.created' : 'message.updated',
      threadId: msg.threadId,
      messageId: msg.id,
      runId: msg.runId,
      authorBotId: msg.authorBotId,
      contentMd: msg.contentMd,
    };
    this.opts.bus.publish(`thread:${msg.threadId}`, live);
  }

  private saveSession(run: Run, sessionId: string | undefined): void {
    if (!run.threadId || !sessionId) return;
    this.opts.repos.sessions.upsert({
      botId: run.botId,
      threadId: run.threadId,
      engine: run.engine,
      engineSessionId: sessionId,
    });
  }

  private publishRun(run: Run): void {
    const live: LiveRunUpdated = {
      type: 'run.updated',
      runId: run.id,
      botId: run.botId,
      threadId: run.threadId,
      taskId: run.taskId,
      status: run.status,
      error: run.error,
    };
    const { bus } = this.opts;
    bus.publish(`run:${run.id}`, live);
    bus.publish(`bot:${run.botId}`, live);
    if (run.threadId) bus.publish(`thread:${run.threadId}`, live);
  }
}
