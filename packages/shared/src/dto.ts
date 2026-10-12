// zod schemas for create/update DTOs. Repos parse inputs with these (defaults applied here),
// and F12+ API routes reuse them to validate request bodies.
import { z } from 'zod';
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
} from './enums';

const isoDate = z.iso.datetime();
const slug = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single dashes');
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour');

// ---------- bots ----------
export const botSettingsSchema = z.object({
  cpus: z.number().positive().max(16).default(2),
  memoryMb: z.number().int().min(256).max(65536).default(4096),
  idleTimeoutMin: z.number().int().min(0).max(1440).default(30),
  flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type BotSettings = z.infer<typeof botSettingsSchema>;

export const botCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  slug: slug.optional(),
  role: z.string().max(200).default(''),
  instructions: z.string().max(100_000).default(''),
  engine: z.enum(ENGINES),
  model: z.string().min(1).max(100).nullable().default(null),
  avatarColor: hexColor.default('#6366f1'),
  avatarShape: z.enum(AVATAR_SHAPES).default('circle'),
  isLead: z.boolean().default(false),
  settings: botSettingsSchema.default(botSettingsSchema.parse({})),
  sidebarVisible: z.boolean().default(true),
  notifications: z.enum(NOTIFICATION_LEVELS).default('all'),
});
export type BotCreateInput = z.input<typeof botCreateSchema>;

export const botUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    slug,
    role: z.string().max(200),
    instructions: z.string().max(100_000),
    engine: z.enum(ENGINES),
    model: z.string().min(1).max(100).nullable(),
    avatarColor: hexColor,
    avatarShape: z.enum(AVATAR_SHAPES),
    isLead: z.boolean(),
    settings: botSettingsSchema,
    sidebarVisible: z.boolean(),
    notifications: z.enum(NOTIFICATION_LEVELS),
  })
  .partial();
export type BotUpdateInput = z.input<typeof botUpdateSchema>;

/** Runtime fields owned by the container manager, not the user-facing update DTO. */
export const botRuntimeUpdateSchema = z
  .object({
    status: z.enum(BOT_STATUSES),
    containerId: z.string().nullable(),
    novncPort: z.number().int().min(1).max(65535).nullable(),
    mcpTokenHash: z.string().nullable(),
  })
  .partial();
export type BotRuntimeUpdate = z.input<typeof botRuntimeUpdateSchema>;

// ---------- threads & messages ----------
export const threadCreateSchema = z.object({
  kind: z.enum(THREAD_KINDS),
  title: z.string().trim().min(1).max(200),
  explainMode: z.boolean().default(false),
  memberBotIds: z.array(z.string()).default([]),
});
export type ThreadCreateInput = z.input<typeof threadCreateSchema>;

export const threadUpdateSchema = z
  .object({ title: z.string().trim().min(1).max(200), explainMode: z.boolean() })
  .partial();
export type ThreadUpdateInput = z.input<typeof threadUpdateSchema>;

export const messageCreateSchema = z
  .object({
    threadId: z.string().min(1),
    authorType: z.enum(AUTHOR_TYPES),
    authorBotId: z.string().nullable().default(null),
    contentMd: z.string().max(200_000),
    runId: z.string().nullable().default(null),
    mentions: z.array(z.string()).default([]),
  })
  .refine((m) => (m.authorType === 'bot') === (m.authorBotId !== null), {
    message: 'authorBotId is required for bot messages and forbidden otherwise',
    path: ['authorBotId'],
  });
export type MessageCreateInput = z.input<typeof messageCreateSchema>;

// ---------- runs ----------
export const runCreateSchema = z.object({
  botId: z.string().min(1),
  threadId: z.string().nullable().default(null),
  taskId: z.string().nullable().default(null),
  trigger: z.enum(RUN_TRIGGERS),
  engine: z.enum(ENGINES),
  prompt: z.string(),
  parentRunId: z.string().nullable().default(null),
  hopCount: z.number().int().min(0).default(0),
});
export type RunCreateInput = z.input<typeof runCreateSchema>;

export const runUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsdEquivalent: z.number().optional(),
});
export type RunUsage = z.infer<typeof runUsageSchema>;

export const runStatusSchema = z.enum(RUN_STATUSES);

// ---------- tasks ----------
export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  descriptionMd: z.string().default(''),
  acceptanceMd: z.string().default(''),
  status: z.enum(TASK_STATUSES).default('todo'),
  priority: z.enum(TASK_PRIORITIES).default('p2'),
  assigneeBotId: z.string().nullable().default(null),
  /** 'user' or the creating bot's id. */
  createdBy: z.string().min(1).default('user'),
  parentTaskId: z.string().nullable().default(null),
  originThreadId: z.string().nullable().default(null),
  taskThreadId: z.string().nullable().default(null),
  executedBy: z.enum(TASK_EXECUTORS).default('agent'),
  dueAt: isoDate.nullable().default(null),
});
export type TaskCreateInput = z.input<typeof taskCreateSchema>;

export const taskUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    descriptionMd: z.string(),
    acceptanceMd: z.string(),
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
    assigneeBotId: z.string().nullable(),
    taskThreadId: z.string().nullable(),
    executedBy: z.enum(TASK_EXECUTORS),
    revisionCount: z.number().int().min(0),
    resultSummaryMd: z.string().nullable(),
    artifacts: z.array(z.string()),
    dueAt: isoDate.nullable(),
  })
  .partial();
export type TaskUpdateInput = z.input<typeof taskUpdateSchema>;

export const taskEventCreateSchema = z.object({
  taskId: z.string().min(1),
  kind: z.string().min(1).max(64),
  actor: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type TaskEventCreateInput = z.input<typeof taskEventCreateSchema>;

// ---------- memories, decisions, lessons ----------
export const memoryCreateSchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    botId: z.string().nullable().default(null),
    title: z.string().trim().min(1).max(200),
    contentMd: z.string().max(50_000),
    tags: z.array(z.string().min(1).max(40)).default([]),
    sourceRunId: z.string().nullable().default(null),
  })
  .refine((m) => (m.scope === 'bot') === (m.botId !== null), {
    message: 'botId is required for bot-scoped memories and forbidden for shared ones',
    path: ['botId'],
  });
export type MemoryCreateInput = z.input<typeof memoryCreateSchema>;

export const memoryUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    contentMd: z.string().max(50_000),
    tags: z.array(z.string().min(1).max(40)),
  })
  .partial();
export type MemoryUpdateInput = z.input<typeof memoryUpdateSchema>;

export const decisionCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  contextMd: z.string().default(''),
  optionsMd: z.string().default(''),
  decisionMd: z.string().default(''),
  consequencesMd: z.string().default(''),
  status: z.enum(DECISION_STATUSES).default('proposed'),
  taskId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  createdBy: z.string().min(1).default('user'),
});
export type DecisionCreateInput = z.input<typeof decisionCreateSchema>;

export const decisionUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    contextMd: z.string(),
    optionsMd: z.string(),
    decisionMd: z.string(),
    consequencesMd: z.string(),
    status: z.enum(DECISION_STATUSES),
  })
  .partial();
export type DecisionUpdateInput = z.input<typeof decisionUpdateSchema>;

export const lessonCreateSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  lessonMd: z.string().min(1),
  whyItMattersMd: z.string().default(''),
  source: z.enum(LESSON_SOURCES).default('manual'),
  sourceId: z.string().nullable().default(null),
  nextReviewAt: isoDate.nullable().default(null),
});
export type LessonCreateInput = z.input<typeof lessonCreateSchema>;

export const lessonUpdateSchema = z
  .object({
    topic: z.string().trim().min(1).max(200),
    lessonMd: z.string().min(1),
    whyItMattersMd: z.string(),
    reviewedCount: z.number().int().min(0),
    nextReviewAt: isoDate.nullable(),
  })
  .partial();
export type LessonUpdateInput = z.input<typeof lessonUpdateSchema>;

// ---------- approvals, schedules, notifications ----------
export const approvalCreateSchema = z.object({
  botId: z.string().min(1),
  runId: z.string().nullable().default(null),
  action: z.string().trim().min(1).max(200),
  detailsMd: z.string().default(''),
  risk: z.enum(RISK_LEVELS).default('medium'),
});
export type ApprovalCreateInput = z.input<typeof approvalCreateSchema>;

export const approvalDecisionSchema = z.object({
  status: z.enum(APPROVAL_STATUSES).exclude(['pending']),
});
export type ApprovalDecisionInput = z.input<typeof approvalDecisionSchema>;

export const scheduleCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  botId: z.string().min(1),
  threadId: z.string().nullable().default(null),
  cron: z.string().trim().min(1).max(100),
  timezone: z.string().min(1).default('UTC'),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  catchUp: z.boolean().default(false),
  nextRunAt: isoDate.nullable().default(null),
});
export type ScheduleCreateInput = z.input<typeof scheduleCreateSchema>;

export const scheduleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    threadId: z.string().nullable(),
    cron: z.string().trim().min(1).max(100),
    timezone: z.string().min(1),
    prompt: z.string().min(1),
    enabled: z.boolean(),
    catchUp: z.boolean(),
    lastRunAt: isoDate.nullable(),
    nextRunAt: isoDate.nullable(),
  })
  .partial();
export type ScheduleUpdateInput = z.input<typeof scheduleUpdateSchema>;

export const notificationCreateSchema = z.object({
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  body: z.string().default(''),
  link: z.string().nullable().default(null),
});
export type NotificationCreateInput = z.input<typeof notificationCreateSchema>;

// ---------- engine state, connectors, guard, settings ----------
export const engineStateUpdateSchema = z.object({
  limitedUntil: isoDate.nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type EngineStateUpdate = z.input<typeof engineStateUpdateSchema>;

export const connectorCreateSchema = z.object({
  type: z.enum(CONNECTOR_TYPES),
  /** Non-secret configuration only; tokens live in data/secrets/. */
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type ConnectorCreateInput = z.input<typeof connectorCreateSchema>;

export const connectorUpdateSchema = z
  .object({ config: z.record(z.string(), z.unknown()), enabled: z.boolean() })
  .partial();
export type ConnectorUpdateInput = z.input<typeof connectorUpdateSchema>;

export const guardTermCreateSchema = z
  .object({
    term: z.string().min(1).max(500),
    kind: z.enum(GUARD_TERM_KINDS).default('literal'),
    note: z.string().max(500).default(''),
  })
  .refine(
    (t) => {
      if (t.kind !== 'regex') return true;
      try {
        new RegExp(t.term);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'invalid regular expression', path: ['term'] },
  );
export type GuardTermCreateInput = z.input<typeof guardTermCreateSchema>;

export const settingKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-zA-Z0-9_.]*$/);
