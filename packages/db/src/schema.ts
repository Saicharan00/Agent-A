// Drizzle schema for every table in PLAN §2 "Data model".
// Conventions: text IDs with prefixes (see @agenta/shared ids), UTC ISO-string timestamps,
// booleans as integer(mode: 'boolean'), JSON as text(mode: 'json').
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { BotSettings, RunUsage } from '@agenta/shared/dto';
import {
  APPROVAL_STATUSES,
  AUTHOR_TYPES,
  AVATAR_SHAPES,
  BOT_STATUSES,
  CONNECTOR_TYPES,
  DECISION_STATUSES,
  ENGINES,
  GUARD_TERM_KINDS,
  LESSON_SOURCES,
  MEMORY_SCOPES,
  NOTIFICATION_LEVELS,
  RISK_LEVELS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  TASK_EXECUTORS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  THREAD_KINDS,
} from '@agenta/shared/enums';

const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();
const bool = (name: string) => integer(name, { mode: 'boolean' });

export const bots = sqliteTable(
  'bots',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    role: text('role').notNull().default(''),
    instructions: text('instructions').notNull().default(''),
    engine: text('engine', { enum: ENGINES }).notNull(),
    model: text('model'),
    avatarColor: text('avatar_color').notNull(),
    avatarShape: text('avatar_shape', { enum: AVATAR_SHAPES }).notNull().default('circle'),
    isLead: bool('is_lead').notNull().default(false),
    status: text('status', { enum: BOT_STATUSES }).notNull().default('stopped'),
    containerId: text('container_id'),
    novncPort: integer('novnc_port'),
    mcpTokenHash: text('mcp_token_hash'),
    settings: text('settings_json', { mode: 'json' }).$type<BotSettings>().notNull(),
    sidebarVisible: bool('sidebar_visible').notNull().default(true),
    notifications: text('notifications', { enum: NOTIFICATION_LEVELS }).notNull().default('all'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: text('archived_at'),
  },
  (t) => [uniqueIndex('bots_slug_uq').on(t.slug)],
);

export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: THREAD_KINDS }).notNull(),
    title: text('title').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    explainMode: bool('explain_mode').notNull().default(false),
    archivedAt: text('archived_at'),
    /** When the owner last viewed the thread (F13 unread counts). Not in PLAN's column list. */
    lastReadAt: text('last_read_at'),
    /** Group chats (F18): what the group is for (shown to bots each turn). */
    purpose: text('purpose').notNull().default(''),
    /** Group chats (F18): who answers messages without @mentions; null = Agent A if present, else the first member. */
    moderatorBotId: text('moderator_bot_id'),
    /** Group chats (F18): paused by the owner; bot mentions start no turns until the owner writes again. */
    pausedAt: text('paused_at'),
    /** Group chats (F18): which messages count as unread (all | mentions = system + @owner | none = muted). */
    notifications: text('notifications', { enum: NOTIFICATION_LEVELS }).notNull().default('all'),
  },
  (t) => [index('threads_updated_idx').on(t.updatedAt)],
);

export const threadMembers = sqliteTable(
  'thread_members',
  {
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    joinedAt: text('joined_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.botId] }), index('thread_members_bot_idx').on(t.botId)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    descriptionMd: text('description_md').notNull().default(''),
    acceptanceMd: text('acceptance_md').notNull().default(''),
    status: text('status', { enum: TASK_STATUSES }).notNull().default('todo'),
    priority: text('priority', { enum: TASK_PRIORITIES }).notNull().default('p2'),
    assigneeBotId: text('assignee_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    /** 'user' or a bot id (not a FK: the creator may be archived/deleted later). */
    createdBy: text('created_by').notNull(),
    parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id, {
      onDelete: 'set null',
    }),
    originThreadId: text('origin_thread_id').references(() => threads.id, { onDelete: 'set null' }),
    taskThreadId: text('task_thread_id').references(() => threads.id, { onDelete: 'set null' }),
    executedBy: text('executed_by', { enum: TASK_EXECUTORS }).notNull().default('agent'),
    revisionCount: integer('revision_count').notNull().default(0),
    resultSummaryMd: text('result_summary_md'),
    artifacts: text('artifacts_json', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    dueAt: text('due_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_status_idx').on(t.status),
    index('tasks_assignee_idx').on(t.assigneeBotId),
    index('tasks_parent_idx').on(t.parentTaskId),
  ],
);

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    trigger: text('trigger', { enum: RUN_TRIGGERS }).notNull(),
    status: text('status', { enum: RUN_STATUSES }).notNull().default('queued'),
    engine: text('engine', { enum: ENGINES }).notNull(),
    prompt: text('prompt').notNull(),
    /** Queue order. Not in PLAN's column list; needed to run queued work FIFO. */
    createdAt: createdAt(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    usage: text('usage_json', { mode: 'json' }).$type<RunUsage>(),
    parentRunId: text('parent_run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    hopCount: integer('hop_count').notNull().default(0),
    /** The usage-limited run this one retries (F10: a limited turn is re-run once after the reset). */
    retryOfRunId: text('retry_of_run_id').references((): AnySQLiteColumn => runs.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('runs_status_created_idx').on(t.status, t.createdAt),
    index('runs_bot_idx').on(t.botId, t.createdAt),
    index('runs_thread_idx').on(t.threadId),
  ],
);

export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: text('payload_json', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_events_run_seq_uq').on(t.runId, t.seq)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    authorType: text('author_type', { enum: AUTHOR_TYPES }).notNull(),
    authorBotId: text('author_bot_id').references(() => bots.id, { onDelete: 'set null' }),
    contentMd: text('content_md').notNull(),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    mentions: text('mentions_json', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (t) => [index('messages_thread_created_idx').on(t.threadId, t.createdAt, t.id)],
);

export const botThreadSessions = sqliteTable(
  'bot_thread_sessions',
  {
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    engine: text('engine', { enum: ENGINES }).notNull(),
    engineSessionId: text('engine_session_id'),
    lastSeenMessageId: text('last_seen_message_id'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.botId, t.threadId] })],
);

export const taskEvents = sqliteTable(
  'task_events',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    actor: text('actor').notNull(),
    payload: text('payload_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('task_events_task_idx').on(t.taskId, t.createdAt)],
);

export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: MEMORY_SCOPES }).notNull(),
    botId: text('bot_id').references(() => bots.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    contentMd: text('content_md').notNull(),
    tags: text('tags', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    sourceRunId: text('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('memories_scope_bot_idx').on(t.scope, t.botId)],
);

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  contextMd: text('context_md').notNull().default(''),
  optionsMd: text('options_md').notNull().default(''),
  decisionMd: text('decision_md').notNull().default(''),
  consequencesMd: text('consequences_md').notNull().default(''),
  status: text('status', { enum: DECISION_STATUSES }).notNull().default('proposed'),
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
});

export const lessons = sqliteTable(
  'lessons',
  {
    id: text('id').primaryKey(),
    topic: text('topic').notNull(),
    lessonMd: text('lesson_md').notNull(),
    whyItMattersMd: text('why_it_matters_md').notNull().default(''),
    source: text('source', { enum: LESSON_SOURCES }).notNull().default('manual'),
    /** Id of the run/task/decision it came from; polymorphic, so no FK. */
    sourceId: text('source_id'),
    reviewedCount: integer('reviewed_count').notNull().default(0),
    nextReviewAt: text('next_review_at'),
    createdAt: createdAt(),
  },
  (t) => [index('lessons_next_review_idx').on(t.nextReviewAt)],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    detailsMd: text('details_md').notNull().default(''),
    risk: text('risk', { enum: RISK_LEVELS }).notNull(),
    status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
    decidedAt: text('decided_at'),
    createdAt: createdAt(),
  },
  (t) => [index('approvals_status_idx').on(t.status, t.createdAt)],
);

export const schedules = sqliteTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => threads.id, { onDelete: 'set null' }),
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    prompt: text('prompt').notNull(),
    enabled: bool('enabled').notNull().default(true),
    catchUp: bool('catch_up').notNull().default(false),
    lastRunAt: text('last_run_at'),
    nextRunAt: text('next_run_at'),
    createdAt: createdAt(),
  },
  (t) => [index('schedules_next_run_idx').on(t.enabled, t.nextRunAt)],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link'),
    readAt: text('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt)],
);

export const engineState = sqliteTable('engine_state', {
  engine: text('engine', { enum: ENGINES }).primaryKey(),
  limitedUntil: text('limited_until'),
  lastError: text('last_error'),
  updatedAt: updatedAt(),
});

export const connectors = sqliteTable('connectors', {
  id: text('id').primaryKey(),
  type: text('type', { enum: CONNECTOR_TYPES }).notNull(),
  /** Non-secret config only. */
  config: text('config_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  enabled: bool('enabled').notNull().default(true),
  createdAt: createdAt(),
});

export const botConnectors = sqliteTable(
  'bot_connectors',
  {
    botId: text('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.botId, t.connectorId] })],
);

export const guardTerms = sqliteTable('guard_terms', {
  id: text('id').primaryKey(),
  term: text('term').notNull(),
  kind: text('kind', { enum: GUARD_TERM_KINDS }).notNull().default('literal'),
  note: text('note').notNull().default(''),
  createdAt: createdAt(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value_json', { mode: 'json' }).$type<unknown>().notNull(),
});

export type Bot = typeof bots.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type ThreadMember = typeof threadMembers.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type BotThreadSession = typeof botThreadSessions.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskEvent = typeof taskEvents.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Lesson = typeof lessons.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Schedule = typeof schedules.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type EngineState = typeof engineState.$inferSelect;
export type Connector = typeof connectors.$inferSelect;
export type GuardTerm = typeof guardTerms.$inferSelect;
export type Setting = typeof settings.$inferSelect;
