// Enum values shared by the DB schema (packages/db) and the zod DTOs (./dto.ts).
// Keep these the single source of truth: PLAN §2 "Data model".

export const ENGINES = ['claude', 'codex', 'mock'] as const;
export type Engine = (typeof ENGINES)[number];

export const AVATAR_SHAPES = ['circle', 'square', 'hexagon'] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const BOT_STATUSES = ['stopped', 'starting', 'running', 'error'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const NOTIFICATION_LEVELS = ['all', 'mentions', 'none'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const THREAD_KINDS = ['dm', 'group', 'task', 'scheduled', 'goal'] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

export const AUTHOR_TYPES = ['user', 'bot', 'system'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const RUN_TRIGGERS = ['user', 'mention', 'delegation', 'task', 'schedule', 'review'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'limited'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES = ['succeeded', 'failed', 'cancelled', 'limited'] as const;

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'in_review',
  'changes_requested',
  'done',
  'blocked',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_EXECUTORS = ['agent', 'human', 'mixed'] as const;
export type TaskExecutor = (typeof TASK_EXECUTORS)[number];

/** A goal (F20): Agent A plans it, the team works its tasks, Agent A reports when every task is done. */
export const GOAL_STATUSES = ['planning', 'in_progress', 'reporting', 'done'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const MEMORY_SCOPES = ['bot', 'shared'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const LESSON_SOURCES = ['run', 'task', 'decision', 'manual'] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const CONNECTOR_TYPES = ['github', 'google'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const GUARD_TERM_KINDS = ['literal', 'regex'] as const;
export type GuardTermKind = (typeof GUARD_TERM_KINDS)[number];
