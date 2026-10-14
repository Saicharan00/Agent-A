// Bot management API (F12): request bodies, the public bot shape and model suggestions.
import { z } from 'zod';
import { botCreateSchema, botSettingsSchema, botUpdateSchema } from './dto';
import { AVATAR_SHAPES, BOT_STATUSES, ENGINES, NOTIFICATION_LEVELS } from './enums';

/** Engines a user can pick for a bot. `mock` stays API-only (tests, demos). */
export const USER_ENGINES = ['claude', 'codex'] as const;

export const ENGINE_LABELS: Record<(typeof ENGINES)[number], string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  mock: 'Mock',
};

/** Suggestions for the free-text model field; null ("default") lets the engine pick. */
export const MODEL_SUGGESTIONS: Record<(typeof ENGINES)[number], string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: ['gpt-5-codex', 'gpt-5'],
  mock: [],
};

/** POST /api/bots. The lead bot (Agent A) is seeded by the platform, so `isLead` is not settable here. */
export const botCreateRequestSchema = botCreateSchema.omit({ isLead: true }).strict();
export type BotCreateRequest = z.input<typeof botCreateRequestSchema>;

/** PATCH /api/bots/:id. */
export const botUpdateRequestSchema = botUpdateSchema.omit({ isLead: true }).strict();
export type BotUpdateRequest = z.input<typeof botUpdateRequestSchema>;

/** DELETE /api/bots/:id: the user must type the bot's exact name; the home folder is kept unless asked. */
export const botDeleteRequestSchema = z.object({
  confirmName: z.string(),
  deleteHome: z.boolean().default(false),
});
export type BotDeleteRequest = z.input<typeof botDeleteRequestSchema>;

/** POST /api/bots/:id/duplicate. Default name: "<name> (copy)". */
export const botDuplicateRequestSchema = z.object({ name: z.string().trim().min(1).max(64).optional() });
export type BotDuplicateRequest = z.input<typeof botDuplicateRequestSchema>;

/** GET /api/bots?archived=exclude|include|only (default exclude). */
export const botListQuerySchema = z.object({
  archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
});
export type BotListQuery = z.input<typeof botListQuerySchema>;

/** A bot as the API returns it: the DB row minus runtime secrets, plus its DM thread and last activity. */
export const botViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.string(),
  instructions: z.string(),
  engine: z.enum(ENGINES),
  model: z.string().nullable(),
  avatarColor: z.string(),
  avatarShape: z.enum(AVATAR_SHAPES),
  isLead: z.boolean(),
  status: z.enum(BOT_STATUSES),
  settings: botSettingsSchema,
  sidebarVisible: z.boolean(),
  notifications: z.enum(NOTIFICATION_LEVELS),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
  /** The owner ↔ bot DM thread (null once archived threads are gone). */
  dmThreadId: z.string().nullable(),
  /** Latest run activity (start or finish), else null. */
  lastActivityAt: z.string().nullable(),
});
export type BotView = z.infer<typeof botViewSchema>;

/** PATCH response: the updated bot, and whether a running computer must restart to apply new limits. */
export const botUpdateResponseSchema = z.object({ bot: botViewSchema, restartRequired: z.boolean() });
export type BotUpdateResponse = z.infer<typeof botUpdateResponseSchema>;

/** Any bot was created, changed, archived, restored or deleted. Channel: `global` (sidebars refetch). */
export const liveBotsChangedSchema = z.object({
  type: z.literal('bots.changed'),
  botId: z.string(),
  change: z.enum(['created', 'updated', 'archived', 'restored', 'deleted']),
});
export type LiveBotsChanged = z.infer<typeof liveBotsChangedSchema>;

/** POST /api/team/reset (F21): template bots created or restored by name, and the Lead Room's thread. */
export const teamResetResponseSchema = z.object({
  created: z.array(z.string()),
  restored: z.array(z.string()),
  leadRoomId: z.string(),
});
export type TeamResetResponse = z.infer<typeof teamResetResponseSchema>;
