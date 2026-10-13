import {
  type Engine,
  type RunCreateInput,
  type RunStatus,
  type RunUsage,
  TERMINAL_RUN_STATUSES,
  msBetween,
  newId,
  nowIso,
  runCreateSchema,
} from '@agenta/shared';
import { and, asc, desc, eq, gt, inArray, max, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { type Run, type RunEvent, runEvents, runs } from '../schema';
import { pageSize, rowidOf } from './util';

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function makeRunsRepo(db: Db) {
  return {
    create(input: RunCreateInput): Run {
      const data = runCreateSchema.parse(input);
      return db
        .insert(runs)
        .values({ ...data, id: newId('run'), status: 'queued', createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): Run | undefined {
      return db.select().from(runs).where(eq(runs.id, id)).get();
    },

    /** Newest first. */
    list(
      opts: {
        botId?: string;
        threadId?: string;
        taskId?: string;
        status?: RunStatus | RunStatus[];
        limit?: number;
      } = {},
    ): Run[] {
      const statuses = opts.status === undefined ? undefined : [opts.status].flat();
      return db
        .select()
        .from(runs)
        .where(
          and(
            opts.botId ? eq(runs.botId, opts.botId) : undefined,
            opts.threadId ? eq(runs.threadId, opts.threadId) : undefined,
            opts.taskId ? eq(runs.taskId, opts.taskId) : undefined,
            statuses ? inArray(runs.status, statuses) : undefined,
          ),
        )
        .orderBy(desc(runs.createdAt), desc(rowidOf(runs)))
        .limit(pageSize(opts.limit, 100))
        .all();
    },

    /** Oldest queued run first (FIFO), optionally for one engine. */
    nextQueued(engine?: Engine): Run | undefined {
      return db
        .select()
        .from(runs)
        .where(and(eq(runs.status, 'queued'), engine ? eq(runs.engine, engine) : undefined))
        .orderBy(asc(runs.createdAt), asc(rowidOf(runs)))
        .get();
    },

    /** Queued runs, oldest first (the scheduler's FIFO). */
    listQueued(limit = 200): Run[] {
      return db
        .select()
        .from(runs)
        .where(eq(runs.status, 'queued'))
        .orderBy(asc(runs.createdAt), asc(rowidOf(runs)))
        .limit(pageSize(limit, 200, 1000))
        .all();
    },

    countByStatus(status: RunStatus, engine?: Engine): number {
      return (
        db
          .select({ n: sql<number>`count(*)` })
          .from(runs)
          .where(and(eq(runs.status, status), engine ? eq(runs.engine, engine) : undefined))
          .get()?.n ?? 0
      );
    },

    /** queued → running. Returns undefined if the run was not queued (e.g. cancelled meanwhile). */
    markRunning(id: string): Run | undefined {
      return db
        .update(runs)
        .set({ status: 'running', startedAt: nowIso() })
        .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
        .returning()
        .get();
    },

    /** Moves a non-terminal run to a terminal status and records duration/error/usage. */
    finish(
      id: string,
      result: { status: TerminalRunStatus; error?: string | null; usage?: RunUsage | null },
    ): Run | undefined {
      const run = this.get(id);
      if (!run || (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return undefined;
      const finishedAt = nowIso();
      return db
        .update(runs)
        .set({
          status: result.status,
          finishedAt,
          durationMs: run.startedAt ? msBetween(run.startedAt, finishedAt) : null,
          ...(result.error !== undefined && { error: result.error }),
          ...(result.usage !== undefined && { usage: result.usage }),
        })
        .where(eq(runs.id, id))
        .returning()
        .get();
    },

    /** Replaces a still-queued run's prompt (merging a duplicate trigger, F18). Undefined once it has started. */
    updateQueuedPrompt(id: string, prompt: string): Run | undefined {
      return db
        .update(runs)
        .set({ prompt })
        .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
        .returning()
        .get();
    },

    /** Put a run back in the queue (e.g. after a limit reset or a runner restart). */
    requeue(id: string): Run | undefined {
      return db
        .update(runs)
        .set({ status: 'queued', startedAt: null, finishedAt: null, durationMs: null, error: null })
        .where(eq(runs.id, id))
        .returning()
        .get();
    },

    delete(id: string): boolean {
      return db.delete(runs).where(eq(runs.id, id)).run().changes > 0;
    },

    /** botId → latest run activity (created, started or finished). Bots without runs are absent. */
    lastActivityByBot(): Map<string, string> {
      const rows = db
        .select({
          botId: runs.botId,
          at: sql<string>`max(coalesce(${runs.finishedAt}, ${runs.startedAt}, ${runs.createdAt}))`,
        })
        .from(runs)
        .groupBy(runs.botId)
        .all();
      return new Map(rows.map((r) => [r.botId, r.at]));
    },

    /** Appends an event with the next per-run sequence number (1, 2, 3…). */
    appendEvent(runId: string, type: string, payload: unknown): RunEvent {
      return db.transaction((tx) => {
        const last = tx
          .select({ seq: max(runEvents.seq) })
          .from(runEvents)
          .where(eq(runEvents.runId, runId))
          .get();
        return tx
          .insert(runEvents)
          .values({ runId, seq: (last?.seq ?? 0) + 1, type, payload, createdAt: nowIso() })
          .returning()
          .get();
      });
    },

    /** Appends several events in one transaction, numbered after the run's last `seq`. */
    appendEvents(runId: string, items: { type: string; payload: unknown }[]): RunEvent[] {
      if (items.length === 0) return [];
      return db.transaction((tx) => {
        const last = tx
          .select({ seq: max(runEvents.seq) })
          .from(runEvents)
          .where(eq(runEvents.runId, runId))
          .get();
        const base = last?.seq ?? 0;
        const createdAt = nowIso();
        return tx
          .insert(runEvents)
          .values(
            items.map((e, i) => ({ runId, seq: base + i + 1, type: e.type, payload: e.payload, createdAt })),
          )
          .returning()
          .all();
      });
    },

    /** How many events of `type` a run has (e.g. limit hits, to retry a limited turn only once). */
    countEvents(runId: string, type: string): number {
      return (
        db
          .select({ n: sql<number>`count(*)` })
          .from(runEvents)
          .where(and(eq(runEvents.runId, runId), eq(runEvents.type, type)))
          .get()?.n ?? 0
      );
    },

    /** Events after `afterSeq` (exclusive) in order — used for WebSocket replay. */
    listEvents(runId: string, afterSeq = 0, limit = 1000): RunEvent[] {
      return db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
        .orderBy(asc(runEvents.seq))
        .limit(pageSize(limit, 1000, 10_000))
        .all();
    },
  };
}
export type RunsRepo = ReturnType<typeof makeRunsRepo>;
