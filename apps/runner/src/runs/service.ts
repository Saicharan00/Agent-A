import type { Bot, Message, Repos, Run } from '@agenta/db';
import type {
  Engine,
  EngineEvent,
  LiveEngineState,
  LiveMessage,
  LiveRunUpdated,
  LiveThreadActivity,
  RunFinishStatus,
  RunTrigger,
  RunUsage,
} from '@agenta/shared';
import { ENGINE_BUDGETS_SETTING, type EngineBudgets, engineBudgetsSchema } from '@agenta/shared';
import type { EventBus } from '../bus';
import { EXEC_FAILED, type Log } from '../engines/cli';
import { CONTAINER_HOME } from '../engines/process';
import { buildSystemPromptAppend } from '../engines/prompt';
import type { EngineRegistry } from '../engines/registry';
import type { EngineRunInput } from '../engines/types';
import { publishEngineFileChange } from '../files/service';
import { RunEventWriter } from './events';
import { notify, notifyRunFinished } from '../notifications/service';

// The run orchestrator (F10): every bot turn is a `runs` row that a single in-process scheduler moves
// queued → running → finished. Runs are owned by the runner, not the browser: events are persisted to
// run_events and published on the bus, and the bot's reply is written to its thread as it arrives.

export const DEFAULT_MAX_CONCURRENT_RUNS = 2;
/** settings key for the global concurrency cap (a positive integer). */
export const MAX_CONCURRENT_SETTING = 'maxConcurrentRuns';
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** How long an engine stays paused when a limit message has no (usable) reset time. */
export const DEFAULT_LIMIT_PAUSE_MS = 30 * 60_000;
export const MCP_CONFIG_PATH = `${CONTAINER_HOME}/.agenta/mcp.json`;
export const WORK_DIR = `${CONTAINER_HOME}/work`;

export const RUNNER_RESTARTED = 'runner restarted';

/** A limited run's error, and the reset time read back from it (the usage report's limit-hit history, F28). */
export const limitedRunError = (engine: Engine, until: string) =>
  `Usage limit reached; ${engine} paused until ${until}`;
export const limitResetOf = (error: string | null) => error?.match(/paused until (\S+)$/)?.[1] ?? null;
export const RUNNER_STOPPED = 'runner stopped';

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
  /** Defaults to the goal of the task, of the thread (a goal thread) or of the parent run. */
  goalId?: string | null;
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
  /** Run time limit when the bot sets none (settings.runTimeoutMin). Default 30 min. */
  defaultTimeoutMs?: number;
  /** Pause before retrying a transient Docker/exec failure. Default 2 s. */
  retryDelayMs?: number;
  /** How long POST /runs/:id/cancel waits for a running engine to stop. Default 15 s. */
  cancelWaitMs?: number;
};

type StopReason = 'cancel' | 'timeout' | 'shutdown';

type Active = { run: Run; controller: AbortController; reason?: StopReason; done: Promise<void> };

/** Bookkeeping while a run executes (across its attempts). */
type Turn = {
  texts: string[];
  messageId?: string;
  usage: RunUsage;
  hasUsage: boolean;
  lastError?: string;
  sessionId?: string;
  engineStatus?: RunFinishStatus;
  limit?: Extract<EngineEvent, { type: 'limit.hit' }>;
};

const OUTPUT_EVENTS = new Set<EngineEvent['type']>([
  'text.delta',
  'text.final',
  'thinking',
  'tool.call',
  'tool.result',
  'file.changed',
]);

/** Error codes worth one retry: the computer or the Docker connection hiccuped, not a permanent setup problem. */
const TRANSIENT_CODES = new Set([
  'start_failed',
  'start_timeout',
  'container_missing',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

export function isTransientError(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  if (typeof e?.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
  // Docker API errors (docker-modem) carry the HTTP status: 5xx is the daemon failing, not a bad request.
  return typeof e?.statusCode === 'number' && e.statusCode >= 500 && e.code === undefined;
}

export class RunService {
  /** Called with a finished turn's reply (group @mention routing, F18; set after construction to avoid a cycle). */
  onReply?: (run: Run, reply: Message) => void;
  private readonly active = new Map<string, Active>();
  private readonly now: () => Date;
  private scheduled = false;
  private stopped = false;
  private poll: NodeJS.Timeout | undefined;

  constructor(private readonly opts: RunServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  // ---------- queue ----------

  /**
   * The goal a new run works for (F20), refusing it while the goal is paused or has used its run budget.
   * Returns null for runs outside any goal.
   */
  admitGoal(input: Pick<EnqueueInput, 'goalId' | 'taskId' | 'threadId' | 'parentRunId'>): string | null {
    const { repos } = this.opts;
    const goalId =
      input.goalId ??
      (input.taskId ? repos.tasks.get(input.taskId)?.goalId : null) ??
      (input.threadId ? repos.goals.getByThread(input.threadId)?.id : null) ??
      (input.parentRunId ? repos.runs.get(input.parentRunId)?.goalId : null) ??
      null;
    const goal = goalId ? repos.goals.get(goalId) : undefined;
    if (!goal) return null;
    if (goal.pausedAt) {
      throw new RunError('goal_paused', `The goal "${goal.title}" is paused; resume it first`, 409);
    }
    if (repos.goals.countRuns(goal.id) >= goal.maxRuns) {
      throw new RunError(
        'goal_run_limit',
        `The goal "${goal.title}" has used all ${goal.maxRuns} of its runs`,
        409,
      );
    }
    return goal.id;
  }

  /** Creates a `queued` run for the bot's effective engine and wakes the scheduler. */
  enqueue(input: EnqueueInput & { retryOfRunId?: string | null }): Run {
    const { repos, engines } = this.opts;
    const bot = repos.bots.get(input.botId);
    if (!bot) throw new RunError('bot_not_found', `Bot ${input.botId} not found`, 404);
    if (bot.archivedAt) throw new RunError('bot_archived', `${bot.name} is archived`, 409);
    const goalId = this.admitGoal(input);
    const run = repos.runs.create({ ...input, goalId, engine: engines.effectiveEngine(bot) });
    this.opts.log.info({ runId: run.id, botId: bot.id, trigger: run.trigger }, 'run queued');
    this.publishRun(run);
    this.schedule();
    return run;
  }

  /**
   * Cancels a queued run at once, or stops a running one (the engine gets SIGINT, then SIGKILL) and waits up to
   * `cancelWaitMs` for it to finish. Returns the run as it is afterwards.
   */
  async cancel(runId: string): Promise<Run> {
    const { repos } = this.opts;
    const run = repos.runs.get(runId);
    if (!run) throw new RunError('run_not_found', `Run ${runId} not found`, 404);
    const active = this.active.get(runId);
    if (active) {
      this.stopActive(active, 'cancel');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        active.done,
        new Promise<void>((r) => (timer = setTimeout(r, this.opts.cancelWaitMs ?? 15_000))),
      ]);
      clearTimeout(timer);
      return repos.runs.get(runId) ?? run;
    }
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new RunError('run_finished', `Run ${runId} already finished (${run.status})`, 409);
    }
    // Queued, or `running` in the DB without an engine in this process (cannot normally happen after recovery).
    return this.finishWithoutEngine(run, 'cancelled', null) ?? repos.runs.get(runId)!;
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

  // ---------- lifecycle ----------

  /**
   * Crash recovery, then scheduling. Runs left `running` by a previous process can't be resumed (their engine
   * process died with the exec connection): they fail with "runner restarted". Queued runs simply start.
   */
  start(): void {
    this.recover();
    this.stopped = false;
    this.poll ??= setInterval(() => this.tick(), this.opts.pollMs ?? 5000);
    this.poll.unref();
    this.schedule();
  }

  recover(): string[] {
    const { repos, log } = this.opts;
    const recovered: string[] = [];
    let stale: Run[];
    do {
      stale = repos.runs.list({ status: 'running', limit: 500 }).filter((r) => !this.active.has(r.id));
      for (const run of stale) {
        if (this.finishWithoutEngine(run, 'failed', RUNNER_RESTARTED)) recovered.push(run.id);
      }
    } while (stale.length === 500);
    if (recovered.length) log.warn({ runs: recovered }, 'runs interrupted by a runner restart marked failed');
    return recovered;
  }

  /** Stops scheduling new runs. Executing runs continue (see shutdown). */
  stop(): void {
    this.stopped = true;
    clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Graceful shutdown: stop scheduling, stop every running engine and wait (bounded) for the outcomes to be saved. */
  async shutdown(timeoutMs = 8000): Promise<void> {
    this.stop();
    const running = [...this.active.values()];
    for (const a of running) this.stopActive(a, 'shutdown');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map((a) => a.done)),
      new Promise<void>((r) => (timer = setTimeout(r, timeoutMs))),
    ]);
    clearTimeout(timer);
  }

  // ---------- scheduler ----------

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

  /** Per-engine daily run budgets (F28); unreadable settings count as none. */
  engineBudgets(): EngineBudgets {
    const parsed = engineBudgetsSchema.safeParse(
      this.opts.repos.settings.get<unknown>(ENGINE_BUDGETS_SETTING),
    );
    return parsed.success ? parsed.data : {};
  }

  /**
   * Starts queued runs FIFO while respecting: the global cap, one running run per bot (its later turns wait),
   * engines paused by a usage limit and engines whose hard daily budget is used up (runs started in the last
   * 24 hours). Synchronous, so two ticks can never pick the same run.
   */
  tick(): void {
    if (this.stopped) return;
    const { repos } = this.opts;
    const nowIso = this.now().toISOString();
    this.clearExpiredLimits(nowIso);
    const max = this.maxConcurrent();
    if (this.active.size >= max) return;
    const busyBots = new Set([...this.active.values()].map((a) => a.run.botId));
    const limited = new Map<Engine, boolean>();
    const isLimited = (e: Engine) => {
      if (!limited.has(e)) limited.set(e, repos.engineState.isLimited(e, nowIso));
      return limited.get(e)!;
    };
    const budgets = this.engineBudgets();
    const dayAgo = new Date(this.now().getTime() - 24 * 3_600_000).toISOString();
    const started = new Map<Engine, number>();
    const overBudget = (e: Engine) => {
      const b = budgets[e];
      if (!b?.hardStop || !b.dailyRuns) return false;
      if (!started.has(e)) started.set(e, repos.runs.countStartedSince(e, dayAgo));
      return started.get(e)! >= b.dailyRuns;
    };
    for (const queued of repos.runs.listQueued()) {
      if (this.active.size >= max) break;
      if (busyBots.has(queued.botId) || isLimited(queued.engine) || overBudget(queued.engine)) continue;
      const run = repos.runs.markRunning(queued.id);
      if (!run) continue; // cancelled meanwhile
      busyBots.add(run.botId);
      if (started.has(run.engine)) started.set(run.engine, started.get(run.engine)! + 1);
      const active: Active = { run, controller: new AbortController(), done: Promise.resolve() };
      this.active.set(run.id, active);
      this.publishRun(run);
      active.done = this.execute(active)
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

  /** Limits whose time has passed: clear them and tell the UI the engine is available again. */
  private clearExpiredLimits(nowIso: string): void {
    const { repos } = this.opts;
    for (const row of repos.engineState.list()) {
      if (!row.limitedUntil || row.limitedUntil > nowIso) continue;
      repos.engineState.clearLimit(row.engine);
      this.opts.log.info({ engine: row.engine }, 'engine usage limit reset');
      this.publishEngineState(row.engine, null);
      notify(repos, this.opts.bus, {
        kind: 'engine.resumed',
        title: `${ENGINE_LABELS[row.engine]} is available again`,
        body: 'Its usage limit has reset; queued runs continue.',
        link: '/usage',
      });
    }
  }

  private stopActive(active: Active, reason: StopReason): void {
    if (active.controller.signal.aborted) return;
    active.reason = reason;
    active.controller.abort();
  }

  // ---------- execution ----------

  private async execute(active: Active): Promise<void> {
    const { run, controller } = active;
    const signal = controller.signal;
    const { repos, log } = this.opts;
    const writer = new RunEventWriter(repos.runs, this.opts.bus, run.id, this.opts.flushMs);
    const turn: Turn = { texts: [], usage: {}, hasUsage: false };
    log.info({ runId: run.id, botId: run.botId, engine: run.engine }, 'run started');

    const bot = repos.bots.get(run.botId);
    const timeoutMs = this.timeoutFor(bot);
    const timer = setTimeout(() => this.stopActive(active, 'timeout'), timeoutMs);
    try {
      if (!bot) throw new Error('The bot was deleted');
      for (let attempt = 1; ; attempt++) {
        const retry = await this.attempt(run, bot, signal, turn, writer);
        if (!retry || attempt >= 2 || signal.aborted) break;
        log.warn({ runId: run.id, err: turn.lastError }, 'transient failure; retrying the run once');
        writer.push({ type: 'system', message: `Transient error (${turn.lastError}); retrying once.` });
        turn.engineStatus = undefined;
        turn.lastError = undefined;
        await abortableDelay(this.opts.retryDelayMs ?? 2000, signal);
      }
    } catch (err) {
      const message = (err as Error).message;
      log.warn({ runId: run.id, err: message }, 'run crashed');
      if (!signal.aborted) {
        turn.lastError = message;
        writer.push({ type: 'error', message });
      }
    } finally {
      clearTimeout(timer);
    }

    let status: RunFinishStatus;
    let error: string | null = null;
    if (active.reason === 'timeout') {
      status = 'failed';
      error = `Timed out after ${formatMinutes(timeoutMs)}`;
      writer.push({ type: 'error', message: `${error}; the run was stopped.` });
    } else if (active.reason === 'shutdown') {
      status = 'failed';
      error = RUNNER_STOPPED;
      writer.push({ type: 'error', message: 'The runner stopped while this run was in progress.' });
    } else if (active.reason === 'cancel') {
      status = 'cancelled';
    } else {
      status = turn.engineStatus ?? 'failed';
      if (turn.limit && status === 'failed') status = 'limited';
      if (status === 'failed') {
        error =
          turn.lastError ??
          (turn.engineStatus ? 'The engine reported a failure' : 'The engine ended without a result');
      }
    }
    if (status === 'limited') error = this.onLimited(run, turn, writer);

    writer.push({ type: 'run.finished', status, ...(turn.sessionId ? { sessionId: turn.sessionId } : {}) });
    writer.flush();
    this.saveSession(run, turn.sessionId);
    const finished = repos.runs.finish(run.id, {
      status,
      error,
      ...(turn.hasUsage ? { usage: turn.usage } : {}),
    });
    log.info({ runId: run.id, status, error }, 'run finished');
    if (!finished) return;
    this.publishRun(finished);
    const reply = status === 'succeeded' && turn.messageId ? repos.messages.get(turn.messageId) : undefined;
    try {
      notifyRunFinished(repos, this.opts.bus, finished, reply?.contentMd);
    } catch (err) {
      log.error({ runId: run.id, err: (err as Error).message }, 'run notification failed');
    }
    try {
      if (reply) this.onReply?.(finished, reply);
    } catch (err) {
      log.error({ runId: run.id, err: (err as Error).message }, 'reply routing failed');
    }
  }

  /** One try at the turn. Returns true when it failed transiently before producing any output (worth a retry). */
  private async attempt(
    run: Run,
    bot: Bot,
    signal: AbortSignal,
    turn: Turn,
    writer: RunEventWriter,
  ): Promise<boolean> {
    let release: (() => void) | undefined;
    let output = false;
    let execFailed = false;
    try {
      try {
        release = await this.opts.prepare?.(bot, run.engine);
      } catch (err) {
        if (signal.aborted) return false;
        turn.lastError = (err as Error).message;
        writer.push({ type: 'error', message: turn.lastError });
        return isTransientError(err);
      }
      const adapter = this.opts.engines.get({ engine: run.engine });
      for await (const event of adapter.run(this.buildInput(run, bot), signal)) {
        if (OUTPUT_EVENTS.has(event.type)) output = true;
        if (event.type === 'error' && event.code === EXEC_FAILED) execFailed = true;
        this.onEvent(run, event, turn, writer);
      }
      return !output && !signal.aborted && turn.engineStatus === 'failed' && execFailed;
    } catch (err) {
      if (signal.aborted) return false;
      turn.lastError = (err as Error).message;
      writer.push({ type: 'error', message: turn.lastError });
      return !output && isTransientError(err);
    } finally {
      release?.();
    }
  }

  /**
   * A usage limit: pause the engine until its reset (or 30 min), notify the owner, and re-run the same turn once
   * as a new queued run that starts when the engine is available again. Returns the run's error text.
   */
  private onLimited(run: Run, turn: Turn, writer: RunEventWriter): string {
    const { repos, log } = this.opts;
    const now = this.now();
    const parsed = turn.limit?.resetsAt ? Date.parse(turn.limit.resetsAt) : NaN;
    const until = new Date(
      Number.isFinite(parsed) && parsed > now.getTime() ? parsed : now.getTime() + DEFAULT_LIMIT_PAUSE_MS,
    ).toISOString();
    const current = repos.engineState.get(run.engine)?.limitedUntil;
    // Several runs can hit the limit together: keep the latest reset time.
    const limitedUntil = current && current > until ? current : until;
    repos.engineState.upsert(run.engine, {
      limitedUntil,
      lastError: (turn.limit?.raw ?? turn.lastError ?? 'usage limit reached').slice(0, 2000),
    });
    this.publishEngineState(run.engine, limitedUntil);
    log.warn({ runId: run.id, engine: run.engine, limitedUntil }, 'engine usage limit hit; queue paused');

    let retry: Run | undefined;
    // Why the retry was refused (its goal paused or out of runs): said in the timeline and the notification.
    let refused: string | undefined;
    if (!run.retryOfRunId) {
      try {
        retry = this.enqueue({
          botId: run.botId,
          threadId: run.threadId,
          taskId: run.taskId,
          trigger: run.trigger,
          prompt: run.prompt,
          parentRunId: run.parentRunId,
          hopCount: run.hopCount,
          retryOfRunId: run.id,
        });
        writer.push({
          type: 'system',
          message: `Usage limit reached. This turn will run again automatically (${retry.id}) after ${limitedUntil}.`,
        });
      } catch (err) {
        refused = (err as Error).message;
        log.warn({ runId: run.id, err: refused }, 'could not queue the retry of a limited run');
        writer.push({
          type: 'system',
          message: `Usage limit reached. This turn was not queued again: ${refused}.`,
        });
      }
    }
    const bot = repos.bots.get(run.botId);
    const engineName = ENGINE_LABELS[run.engine];
    notify(repos, this.opts.bus, {
      kind: 'engine.limited',
      title: `${engineName} usage limit reached`,
      body: [
        `${engineName} runs are paused until ${limitedUntil} (UTC).`,
        retry
          ? `${bot?.name ?? 'The bot'}'s turn will run again automatically then.`
          : refused
            ? `${bot?.name ?? 'The bot'}'s turn will not be retried: ${refused}. Ask again once that is sorted.`
            : `${bot?.name ?? 'The bot'}'s turn already hit the limit once before, so it will not be retried.`,
      ].join(' '),
      link: '/usage',
    });
    return limitedRunError(run.engine, limitedUntil);
  }

  /** Ends a run that has no engine executing in this process (queued, or orphaned by a restart). */
  private finishWithoutEngine(
    run: Run,
    status: 'cancelled' | 'failed',
    error: string | null,
  ): Run | undefined {
    const { repos } = this.opts;
    const writer = new RunEventWriter(repos.runs, this.opts.bus, run.id, 0);
    if (status === 'failed' && error === RUNNER_RESTARTED) {
      writer.push({ type: 'error', message: 'The runner restarted while this run was in progress.' });
    }
    writer.push({ type: 'run.finished', status });
    const finished = repos.runs.finish(run.id, { status, error });
    if (finished) this.publishRun(finished);
    this.schedule();
    return finished;
  }

  private timeoutFor(bot: Bot | undefined): number {
    const min = bot?.settings.runTimeoutMin;
    return typeof min === 'number' && min > 0
      ? min * 60_000
      : (this.opts.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
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
      systemPromptAppend: buildSystemPromptAppend(
        bot,
        thread,
        thread?.kind === 'goal' ? repos.goals.getByThread(thread.id) : null,
      ),
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
      case 'limit.hit':
        turn.limit = event;
        break;
      case 'file.changed':
        // Lets an open Files tab refresh (shell-made changes have no event; the tab also re-polls).
        publishEngineFileChange(this.opts.bus, run.botId, event.path, event.change);
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
      authorType: msg.authorType,
      createdAt: msg.createdAt,
    };
    this.opts.bus.publish(`thread:${msg.threadId}`, live);
    if (created) {
      const activity: LiveThreadActivity = {
        type: 'thread.activity',
        threadId: msg.threadId,
        messageId: msg.id,
        authorType: msg.authorType,
      };
      this.opts.bus.publish('global', activity);
    }
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

  private publishEngineState(engine: Engine, limitedUntil: string | null): void {
    const live: LiveEngineState = { type: 'engine.state', engine, limitedUntil };
    this.opts.bus.publish('global', live);
  }
}

const ENGINE_LABELS: Record<Engine, string> = { claude: 'Claude Code', codex: 'Codex', mock: 'Mock engine' };

function formatMinutes(ms: number): string {
  const min = ms / 60_000;
  return min >= 1 ? `${Math.round(min * 10) / 10} min` : `${Math.round(ms / 1000)} s`;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
