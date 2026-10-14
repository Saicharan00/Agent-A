// Scheduled tasks (F26): recurring prompts a bot runs on a cron timer, their history and the live event.
import { z } from 'zod';
import { RUN_STATUSES } from './enums';

export const DEFAULT_SCHEDULE_TIMEZONE = 'America/New_York';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timeZone = z.string().min(1).max(100).refine(isValidTimeZone, 'Unknown time zone');

export const SCHEDULE_OUTCOMES = ['started', 'skipped', 'failed'] as const;
export type ScheduleOutcome = (typeof SCHEDULE_OUTCOMES)[number];

export const scheduleViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  botId: z.string(),
  /** null = a new thread for each run. */
  threadId: z.string().nullable(),
  cron: z.string(),
  timezone: z.string(),
  prompt: z.string(),
  enabled: z.boolean(),
  catchUp: z.boolean(),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ScheduleView = z.infer<typeof scheduleViewSchema>;

/** POST /api/schedules */
export const scheduleCreateRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  botId: z.string().min(1),
  threadId: z.string().min(1).nullable().default(null),
  cron: z.string().trim().min(1).max(100),
  timezone: timeZone.default(DEFAULT_SCHEDULE_TIMEZONE),
  prompt: z.string().trim().min(1).max(20_000),
  enabled: z.boolean().default(true),
  catchUp: z.boolean().default(false),
});
export type ScheduleCreateRequest = z.input<typeof scheduleCreateRequestSchema>;

/** PATCH /api/schedules/:id */
export const scheduleUpdateRequestSchema = scheduleCreateRequestSchema
  .extend({ timezone: timeZone })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type ScheduleUpdateRequest = z.input<typeof scheduleUpdateRequestSchema>;

/** One firing of a schedule (timer or "Run now"): the run it started, or why it was skipped or failed. */
export const scheduleRunViewSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  outcome: z.enum(SCHEDULE_OUTCOMES),
  manual: z.boolean(),
  reason: z.string().nullable(),
  runId: z.string().nullable(),
  threadId: z.string().nullable(),
  /** The run's current status, when one was started. */
  runStatus: z.enum(RUN_STATUSES).nullable(),
  createdAt: z.string(),
});
export type ScheduleRunView = z.infer<typeof scheduleRunViewSchema>;

/** A schedule was created, changed, deleted or fired. Channel: `global`. */
export const liveScheduleChangedSchema = z.object({
  type: z.literal('schedule.changed'),
  scheduleId: z.string(),
});
export type LiveScheduleChanged = z.infer<typeof liveScheduleChangedSchema>;
