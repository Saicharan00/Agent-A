// Approvals, schedules, notifications and engine limit state.
import {
  type ApprovalCreateInput,
  type ApprovalDecisionInput,
  type ApprovalStatus,
  type Engine,
  type EngineStateUpdate,
  type NotificationCreateInput,
  type ScheduleCreateInput,
  type ScheduleUpdateInput,
  approvalCreateSchema,
  approvalDecisionSchema,
  engineStateUpdateSchema,
  newId,
  notificationCreateSchema,
  nowIso,
  scheduleCreateSchema,
  scheduleUpdateSchema,
} from '@agenta/shared';
import { and, asc, desc, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  type Approval,
  type EngineState,
  type Notification,
  type Schedule,
  type ScheduleRun,
  approvals,
  engineState,
  notifications,
  scheduleRuns,
  schedules,
} from '../schema';
import { definedOnly, isEmpty, pageSize } from './util';

export function makeApprovalsRepo(db: Db) {
  return {
    create(input: ApprovalCreateInput): Approval {
      const data = approvalCreateSchema.parse(input);
      return db
        .insert(approvals)
        .values({ ...data, id: newId('approval'), status: 'pending', createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): Approval | undefined {
      return db.select().from(approvals).where(eq(approvals.id, id)).get();
    },

    /** Newest first. */
    list(opts: { status?: ApprovalStatus; botId?: string; runId?: string } = {}): Approval[] {
      return db
        .select()
        .from(approvals)
        .where(
          and(
            opts.status ? eq(approvals.status, opts.status) : undefined,
            opts.botId ? eq(approvals.botId, opts.botId) : undefined,
            opts.runId ? eq(approvals.runId, opts.runId) : undefined,
          ),
        )
        .orderBy(desc(approvals.createdAt))
        .all();
    },

    /** pending → approved/denied/expired. Returns undefined if it was already decided. */
    decide(id: string, input: ApprovalDecisionInput): Approval | undefined {
      const { status, note } = approvalDecisionSchema.parse(input);
      return db
        .update(approvals)
        .set({ status, note: note || null, decidedAt: nowIso() })
        .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')))
        .returning()
        .get();
    },

    /** Expires pending approvals created before `before`. Returns how many expired. */
    expireOlderThan(before: string, at: string = nowIso()): number {
      return db
        .update(approvals)
        .set({ status: 'expired', decidedAt: at })
        .where(and(eq(approvals.status, 'pending'), lte(approvals.createdAt, before)))
        .run().changes;
    },

    delete(id: string): boolean {
      return db.delete(approvals).where(eq(approvals.id, id)).run().changes > 0;
    },
  };
}
export type ApprovalsRepo = ReturnType<typeof makeApprovalsRepo>;

export function makeSchedulesRepo(db: Db) {
  return {
    create(input: ScheduleCreateInput): Schedule {
      const data = scheduleCreateSchema.parse(input);
      return db
        .insert(schedules)
        .values({ ...data, id: newId('schedule'), createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): Schedule | undefined {
      return db.select().from(schedules).where(eq(schedules.id, id)).get();
    },

    list(opts: { botId?: string; enabled?: boolean } = {}): Schedule[] {
      return db
        .select()
        .from(schedules)
        .where(
          and(
            opts.botId ? eq(schedules.botId, opts.botId) : undefined,
            opts.enabled !== undefined ? eq(schedules.enabled, opts.enabled) : undefined,
          ),
        )
        .orderBy(asc(schedules.createdAt))
        .all();
    },

    /** Enabled schedules whose next_run_at is at or before `at`. */
    listDue(at: string = nowIso()): Schedule[] {
      return db
        .select()
        .from(schedules)
        .where(and(eq(schedules.enabled, true), isNotNull(schedules.nextRunAt), lte(schedules.nextRunAt, at)))
        .orderBy(asc(schedules.nextRunAt))
        .all();
    },

    update(id: string, input: ScheduleUpdateInput): Schedule | undefined {
      const patch = definedOnly(scheduleUpdateSchema.parse(input));
      if (isEmpty(patch)) return this.get(id);
      return db.update(schedules).set(patch).where(eq(schedules.id, id)).returning().get();
    },

    delete(id: string): boolean {
      return db.delete(schedules).where(eq(schedules.id, id)).run().changes > 0;
    },

    /** Records one firing (F26). `at` defaults to now (tests pass a fake clock). */
    addRun(
      input: Pick<ScheduleRun, 'scheduleId' | 'outcome'> &
        Partial<Pick<ScheduleRun, 'manual' | 'reason' | 'runId' | 'threadId'>>,
      at: string = nowIso(),
    ): ScheduleRun {
      return db
        .insert(scheduleRuns)
        .values({ ...input, id: newId('scheduleRun'), createdAt: at })
        .returning()
        .get();
    },

    /** Newest first. */
    listRuns(scheduleId: string, limit?: number): ScheduleRun[] {
      return db
        .select()
        .from(scheduleRuns)
        .where(eq(scheduleRuns.scheduleId, scheduleId))
        .orderBy(desc(scheduleRuns.createdAt), desc(scheduleRuns.id))
        .limit(pageSize(limit, 50))
        .all();
    },
  };
}
export type SchedulesRepo = ReturnType<typeof makeSchedulesRepo>;

export function makeNotificationsRepo(db: Db) {
  return {
    create(input: NotificationCreateInput): Notification {
      const data = notificationCreateSchema.parse(input);
      return db
        .insert(notifications)
        .values({ ...data, id: newId('notification'), createdAt: nowIso() })
        .returning()
        .get();
    },

    get(id: string): Notification | undefined {
      return db.select().from(notifications).where(eq(notifications.id, id)).get();
    },

    /** Newest first. */
    list(opts: { unreadOnly?: boolean; limit?: number } = {}): Notification[] {
      return db
        .select()
        .from(notifications)
        .where(opts.unreadOnly ? isNull(notifications.readAt) : undefined)
        .orderBy(desc(notifications.createdAt))
        .limit(pageSize(opts.limit, 100))
        .all();
    },

    countUnread(): number {
      return (
        db
          .select({ n: sql<number>`count(*)` })
          .from(notifications)
          .where(isNull(notifications.readAt))
          .get()?.n ?? 0
      );
    },

    markRead(id: string): Notification | undefined {
      return db
        .update(notifications)
        .set({ readAt: nowIso() })
        .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
        .returning()
        .get();
    },

    markAllRead(): number {
      return db.update(notifications).set({ readAt: nowIso() }).where(isNull(notifications.readAt)).run()
        .changes;
    },

    delete(id: string): boolean {
      return db.delete(notifications).where(eq(notifications.id, id)).run().changes > 0;
    },
  };
}
export type NotificationsRepo = ReturnType<typeof makeNotificationsRepo>;

/** Per-engine limit state (subscription limit hits pause that engine's queue). */
export function makeEngineStateRepo(db: Db) {
  return {
    get(engine: Engine): EngineState | undefined {
      return db.select().from(engineState).where(eq(engineState.engine, engine)).get();
    },

    list(): EngineState[] {
      return db.select().from(engineState).orderBy(asc(engineState.engine)).all();
    },

    /** Insert or update; omitted fields keep their stored value. */
    upsert(engine: Engine, input: EngineStateUpdate): EngineState {
      const patch = { ...definedOnly(engineStateUpdateSchema.parse(input)), updatedAt: nowIso() };
      return db
        .insert(engineState)
        .values({ engine, ...patch })
        .onConflictDoUpdate({ target: engineState.engine, set: patch })
        .returning()
        .get();
    },

    /** True while `limited_until` is in the future. */
    isLimited(engine: Engine, at: string = nowIso()): boolean {
      const row = this.get(engine);
      return !!row?.limitedUntil && row.limitedUntil > at;
    },

    clearLimit(engine: Engine): EngineState {
      return this.upsert(engine, { limitedUntil: null });
    },
  };
}
export type EngineStateRepo = ReturnType<typeof makeEngineStateRepo>;
