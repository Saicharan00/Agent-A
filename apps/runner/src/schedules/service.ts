import type { Bot, Repos, Schedule, ScheduleRun } from '@agenta/db';
import {
  type Engine,
  type LiveScheduleChanged,
  type ScheduleCreateRequest,
  type ScheduleOutcome,
  type ScheduleRunView,
  type ScheduleUpdateRequest,
  type ScheduleView,
  scheduleCreateRequestSchema,
  scheduleRunViewSchema,
  scheduleUpdateRequestSchema,
  scheduleViewSchema,
} from '@agenta/shared';
import { Cron } from 'croner';
import type { EventBus } from '../bus';
import type { ThreadService } from '../threads/service';

type Log = {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
};

/** A due time further back than this was missed (the app was not running, or the machine slept). */
export const MISSED_GRACE_MS = 2 * 60_000;
export const SCHEDULE_TICK_MS = 30_000;

export class ScheduleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Throws a 400 ScheduleError for a cron expression croner can't use. Five fields or a nickname like @daily. */
export function nextCronRun(cron: string, timezone: string, after: Date): string | null {
  const fields = cron.trim().split(/\s+/);
  // Seconds/years fields would fire faster than the tick; keep to standard cron.
  if (!cron.trim().startsWith('@') && fields.length !== 5) {
    throw new ScheduleError(
      'invalid_cron',
      'Cron needs 5 fields: minute hour day-of-month month day-of-week',
      400,
    );
  }
  try {
    return new Cron(cron, { timezone, paused: true }).nextRun(after)?.toISOString() ?? null;
  } catch (err) {
    throw new ScheduleError('invalid_cron', err instanceof Error ? err.message : 'Invalid cron', 400);
  }
}

export type ScheduleServiceOptions = {
  repos: Repos;
  threads: Pick<ThreadService, 'ownerAsks'>;
  /** The engine a bot's runs use (engine override aware). */
  effectiveEngine: (bot: Bot) => Engine;
  bus?: EventBus;
  log?: Log;
  /** Fake clock in tests. */
  now?: () => Date;
  tickMs?: number;
};

const toView = (s: Schedule): ScheduleView => scheduleViewSchema.parse(s);

/**
 * Scheduled tasks (PLAN F26). Each enabled schedule stores its next due time; a tick fires the due ones by posting
 * the prompt as the owner's message in the target thread (or a new thread each run) and giving the bot a turn.
 * Skips are recorded with a reason: missed while the app was off (unless catch-up), engine limited (catch-up retries
 * at the reset), or the previous run still going. Croner only does the cron math, so a fake clock drives it in tests.
 */
export class ScheduleService {
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: ScheduleServiceOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.tick();
    this.timer ??= setInterval(() => this.tick(), this.opts.tickMs ?? SCHEDULE_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): ScheduleView[] {
    return this.opts.repos.schedules.list().map(toView);
  }

  get(id: string): ScheduleView {
    return toView(this.schedule(id));
  }

  create(body: ScheduleCreateRequest): ScheduleView {
    const req = scheduleCreateRequestSchema.parse(body);
    this.checkTargets(req.botId, req.threadId);
    const nextRunAt = req.enabled ? nextCronRun(req.cron, req.timezone, this.now()) : null;
    const s = this.opts.repos.schedules.create({ ...req, nextRunAt });
    this.opts.log?.info({ scheduleId: s.id, botId: s.botId, cron: s.cron }, 'schedule created');
    this.changed(s.id);
    return toView(s);
  }

  update(id: string, body: ScheduleUpdateRequest): ScheduleView {
    const current = this.schedule(id);
    const req = scheduleUpdateRequestSchema.parse(body);
    this.checkTargets(req.botId ?? current.botId, req.threadId === undefined ? null : req.threadId);
    const merged = { ...current, ...req };
    // The timing changed (or the schedule was switched on): due next at the next occurrence from now.
    const retime = req.cron !== undefined || req.timezone !== undefined || req.enabled !== undefined;
    const nextRunAt = retime
      ? merged.enabled
        ? nextCronRun(merged.cron, merged.timezone, this.now())
        : null
      : undefined;
    const s = this.opts.repos.schedules.update(id, { ...req, nextRunAt })!;
    this.changed(id);
    return toView(s);
  }

  delete(id: string): void {
    this.schedule(id);
    this.opts.repos.schedules.delete(id);
    this.changed(id);
  }

  history(id: string): ScheduleRunView[] {
    this.schedule(id);
    return this.opts.repos.schedules.listRuns(id).map((r) => this.toRunView(r));
  }

  /** "Run now": fires at once, whatever the timer says; the next timed run is unchanged. */
  runNow(id: string): ScheduleRunView {
    const s = this.schedule(id);
    const r = this.fire(s, true);
    this.changed(id);
    return this.toRunView(r);
  }

  /** Fires every due schedule. Returns the firings recorded. */
  tick(): ScheduleRun[] {
    const { repos, log } = this.opts;
    const out: ScheduleRun[] = [];
    for (const s of repos.schedules.listDue(this.now().toISOString())) {
      try {
        out.push(this.due(s));
      } catch (err) {
        // A broken schedule (e.g. its cron no longer parses) must not stop the others; switch it off.
        log?.error({ err, scheduleId: s.id }, 'schedule tick failed');
        repos.schedules.update(s.id, { enabled: false, nextRunAt: null });
        out.push(
          this.record(s, 'failed', `Switched off: ${err instanceof Error ? err.message : err}`, false),
        );
      }
      this.changed(s.id);
    }
    return out;
  }

  private due(s: Schedule): ScheduleRun {
    const { repos, log } = this.opts;
    const now = this.now();
    const nowIso = now.toISOString();
    const next = nextCronRun(s.cron, s.timezone, now);
    const late = now.getTime() - Date.parse(s.nextRunAt!) > MISSED_GRACE_MS;
    let r: ScheduleRun;
    let nextRunAt = next;
    const bot = repos.bots.get(s.botId);
    const engine = bot && this.opts.effectiveEngine(bot);
    const limitedUntil = engine && repos.engineState.get(engine)?.limitedUntil;
    if (late && !s.catchUp) {
      r = this.record(
        s,
        'skipped',
        `Missed at ${s.nextRunAt} while the app was not running (catch-up is off)`,
      );
    } else if (limitedUntil && limitedUntil > nowIso) {
      const retry = s.catchUp && (!next || limitedUntil < next);
      if (retry) nextRunAt = limitedUntil;
      r = this.record(
        s,
        'skipped',
        `${engine} is limited until ${limitedUntil}${retry ? '; retrying after the reset' : ''}`,
      );
    } else if (this.previousStillGoing(s)) {
      r = this.record(s, 'skipped', 'The previous run of this schedule is still going');
    } else {
      r = this.fire(s, false);
    }
    if (r.outcome === 'skipped') log?.info({ scheduleId: s.id, reason: r.reason }, 'schedule skipped');
    repos.schedules.update(s.id, { nextRunAt, ...(r.outcome === 'skipped' ? {} : { lastRunAt: nowIso }) });
    return r;
  }

  private fire(s: Schedule, manual: boolean): ScheduleRun {
    const { repos, log } = this.opts;
    const bot = repos.bots.get(s.botId);
    if (!bot || bot.archivedAt) return this.record(s, 'failed', 'The bot is archived', manual);
    try {
      const threadId = s.threadId ?? this.newThread(s, bot);
      const res = this.opts.threads.ownerAsks(
        bot,
        threadId,
        `**Scheduled: ${s.name}**\n\n${s.prompt}`,
        'schedule',
      );
      if (manual) repos.schedules.update(s.id, { lastRunAt: this.now().toISOString() });
      log?.info({ scheduleId: s.id, runId: res.runs[0]?.id, manual }, 'schedule fired');
      return this.record(s, 'started', null, manual, { runId: res.runs[0]?.id ?? null, threadId });
    } catch (err) {
      log?.warn({ err, scheduleId: s.id }, 'schedule could not start its run');
      return this.record(s, 'failed', err instanceof Error ? err.message : String(err), manual);
    }
  }

  private newThread(s: Schedule, bot: Bot): string {
    const when = new Intl.DateTimeFormat('en-US', {
      timeZone: s.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(this.now());
    return this.opts.repos.threads.create({
      kind: 'scheduled',
      title: `${s.name} · ${when}`.slice(0, 200),
      memberBotIds: [bot.id],
    }).id;
  }

  private previousStillGoing(s: Schedule): boolean {
    const last = this.opts.repos.schedules.listRuns(s.id).find((r) => r.outcome === 'started');
    const run = last?.runId ? this.opts.repos.runs.get(last.runId) : undefined;
    return run?.status === 'queued' || run?.status === 'running';
  }

  private record(
    s: Schedule,
    outcome: ScheduleOutcome,
    reason: string | null,
    manual = false,
    refs: { runId?: string | null; threadId?: string | null } = {},
  ): ScheduleRun {
    return this.opts.repos.schedules.addRun(
      { scheduleId: s.id, outcome, reason, manual, ...refs },
      this.now().toISOString(),
    );
  }

  private toRunView(r: ScheduleRun): ScheduleRunView {
    const run = r.runId ? this.opts.repos.runs.get(r.runId) : undefined;
    return scheduleRunViewSchema.parse({ ...r, runStatus: run?.status ?? null });
  }

  private checkTargets(botId: string, threadId: string | null): void {
    const { repos } = this.opts;
    const bot = repos.bots.get(botId);
    if (!bot) throw new ScheduleError('bot_not_found', `Bot ${botId} not found`, 404);
    if (bot.archivedAt) throw new ScheduleError('bot_archived', `${bot.name} is archived`, 409);
    if (threadId && !repos.threads.get(threadId)) {
      throw new ScheduleError('thread_not_found', `Thread ${threadId} not found`, 404);
    }
  }

  private schedule(id: string): Schedule {
    const s = this.opts.repos.schedules.get(id);
    if (!s) throw new ScheduleError('not_found', `Schedule ${id} not found`, 404);
    return s;
  }

  private changed(scheduleId: string): void {
    const event: LiveScheduleChanged = { type: 'schedule.changed', scheduleId };
    this.opts.bus?.publish('global', event);
  }
}
