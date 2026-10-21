// Task board API (F19): task views, the owner's create/patch requests, and the live `task.changed` event.
import { z } from 'zod';
import { TASK_EXECUTORS, TASK_PRIORITIES, TASK_STATUSES } from './enums';

export const TASK_STATUS_LABELS: Record<(typeof TASK_STATUSES)[number], string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  done: 'Done',
  blocked: 'Blocked',
};

export const taskViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  descriptionMd: z.string(),
  acceptanceMd: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  assigneeBotId: z.string().nullable(),
  /** 'user' or the creating bot's id. */
  createdBy: z.string(),
  parentTaskId: z.string().nullable(),
  originThreadId: z.string().nullable(),
  taskThreadId: z.string().nullable(),
  executedBy: z.enum(TASK_EXECUTORS),
  revisionCount: z.number().int(),
  resultSummaryMd: z.string().nullable(),
  /** Paths in the bot's computer (/shared/…, /home/bot/…) or URLs. */
  artifacts: z.array(z.string()),
  dueAt: z.string().nullable(),
  /** The goal it belongs to (F20). */
  goalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskView = z.infer<typeof taskViewSchema>;

export const taskEventViewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.string(),
  /** 'user' or a bot id. */
  actor: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type TaskEventView = z.infer<typeof taskEventViewSchema>;

/** GET /api/tasks/:id — the task with its sub-tasks and timeline (oldest first). */
export const taskDetailSchema = taskViewSchema.extend({
  subtasks: z.array(taskViewSchema),
  events: z.array(taskEventViewSchema),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

const dueAt = z.iso.datetime().nullable();

/** POST /api/tasks — an owner-created task; one assigned to a bot (and not human-executed) starts at once. */
export const taskCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  descriptionMd: z.string().max(50_000).default(''),
  acceptanceMd: z.string().max(50_000).default(''),
  priority: z.enum(TASK_PRIORITIES).default('p2'),
  assigneeBotId: z.string().min(1).nullable().default(null),
  parentTaskId: z.string().min(1).nullable().default(null),
  executedBy: z.enum(TASK_EXECUTORS).default('agent'),
  dueAt: dueAt.default(null),
});
export type TaskCreateRequest = z.input<typeof taskCreateRequestSchema>;

/** PATCH /api/tasks/:id — any field; a new bot assignee starts the task. */
export const taskPatchRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    descriptionMd: z.string().max(50_000),
    acceptanceMd: z.string().max(50_000),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    assigneeBotId: z.string().min(1).nullable(),
    parentTaskId: z.string().min(1).nullable(),
    executedBy: z.enum(TASK_EXECUTORS),
    dueAt,
  })
  .partial();
export type TaskPatchRequest = z.input<typeof taskPatchRequestSchema>;

/** POST /api/tasks/:id/request-changes */
export const taskRequestChangesSchema = z.object({ feedback: z.string().trim().min(1).max(20_000) });
export type TaskRequestChanges = z.input<typeof taskRequestChangesSchema>;

/** A task was created, changed (status, fields, timeline) or deleted. Channel: `global`. */
export const liveTaskChangedSchema = z.object({
  type: z.literal('task.changed'),
  taskId: z.string(),
  /** Set when the task was deleted: its goal can no longer be looked up from the task. */
  goalId: z.string().optional(),
});
export type LiveTaskChanged = z.infer<typeof liveTaskChangedSchema>;
