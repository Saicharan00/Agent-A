// Goals (F20): the owner's goal → Agent A's plan → tasks → reviews → report. Repo inputs, API views and requests.
import { z } from 'zod';
import { GOAL_STATUSES } from './enums';

/** Per-goal guardrails (PLAN F20). */
export const DEFAULT_GOAL_MAX_TASKS = 12;
export const DEFAULT_GOAL_MAX_RUNS = 40;
/** Rounds of "request changes" Agent A may send per task before the owner decides. */
export const MAX_REVISION_ROUNDS = 2;

/** Where a goal's team puts its artifacts (inside every bot's computer). */
export function goalArtifactsDir(slug: string): string {
  return `/shared/projects/${slug}/`;
}

export const goalCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z.string().min(1).max(64),
  goalMd: z.string().max(20_000),
  constraintsMd: z.string().max(20_000).default(''),
  autoRun: z.boolean().default(false),
  maxTasks: z.number().int().min(1).max(100).default(DEFAULT_GOAL_MAX_TASKS),
  maxRuns: z.number().int().min(1).max(1000).default(DEFAULT_GOAL_MAX_RUNS),
  leadBotId: z.string().min(1),
  threadId: z.string().min(1),
});
export type GoalCreateInput = z.input<typeof goalCreateSchema>;

export const goalUpdateSchema = z
  .object({
    status: z.enum(GOAL_STATUSES),
    confirmedAt: z.string().nullable(),
    pausedAt: z.string().nullable(),
    reportRunId: z.string().nullable(),
    finishedAt: z.string().nullable(),
    maxRuns: z.number().int().min(1).max(1000),
  })
  .partial();
export type GoalUpdateInput = z.input<typeof goalUpdateSchema>;

/** PATCH /api/goals/:id — the owner changes the goal's run budget (F28). */
export const goalPatchRequestSchema = z.object({ maxRuns: z.number().int().min(1).max(1000) });
export type GoalPatchRequest = z.infer<typeof goalPatchRequestSchema>;

export const goalViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  slug: z.string(),
  goalMd: z.string(),
  constraintsMd: z.string(),
  status: z.enum(GOAL_STATUSES),
  autoRun: z.boolean(),
  confirmedAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  maxTasks: z.number().int(),
  maxRuns: z.number().int(),
  leadBotId: z.string().nullable(),
  threadId: z.string().nullable(),
  reportRunId: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Progress and budget. */
  tasksTotal: z.number().int(),
  tasksDone: z.number().int(),
  runsUsed: z.number().int(),
});
export type GoalView = z.infer<typeof goalViewSchema>;

/** POST /api/goals — the owner's goal. Title defaults to the goal's first line. */
export const goalCreateRequestSchema = z.object({
  title: z.string().trim().max(200).optional(),
  goalMd: z.string().trim().min(1).max(20_000),
  constraintsMd: z.string().trim().max(20_000).default(''),
  autoRun: z.boolean().default(false),
  maxTasks: z.number().int().min(1).max(100).default(DEFAULT_GOAL_MAX_TASKS),
  maxRuns: z.number().int().min(1).max(1000).default(DEFAULT_GOAL_MAX_RUNS),
});
export type GoalCreateRequest = z.input<typeof goalCreateRequestSchema>;

/** A goal was created or changed (status, pause, progress). Channel: `global`. */
export const liveGoalChangedSchema = z.object({
  type: z.literal('goal.changed'),
  goalId: z.string(),
});
export type LiveGoalChanged = z.infer<typeof liveGoalChangedSchema>;
