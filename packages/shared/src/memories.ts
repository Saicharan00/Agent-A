// Memory system (F22): what the API and the UI exchange about bot and shared memories.
import { z } from 'zod';
import { MEMORY_SCOPES } from './enums';

export const memoryViewSchema = z.object({
  id: z.string(),
  scope: z.enum(MEMORY_SCOPES),
  botId: z.string().nullable(),
  title: z.string(),
  contentMd: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  sourceRunId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MemoryView = z.infer<typeof memoryViewSchema>;

const tags = z.array(z.string().trim().min(1).max(40)).max(10);

/** POST /api/memories: the owner adds a memory for a bot (`botId`) or for the whole team (scope `shared`). */
export const memoryCreateRequestSchema = z
  .object({
    scope: z.enum(MEMORY_SCOPES),
    botId: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(200),
    contentMd: z.string().trim().min(1).max(50_000),
    tags: tags.default([]),
    pinned: z.boolean().default(false),
  })
  .refine((m) => (m.scope === 'bot') === (m.botId !== undefined), {
    message: 'botId is required for bot memories and not allowed for shared ones',
    path: ['botId'],
  });
export type MemoryCreateRequest = z.input<typeof memoryCreateRequestSchema>;

/** PATCH /api/memories/:id. */
export const memoryUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    contentMd: z.string().trim().min(1).max(50_000),
    tags,
    pinned: z.boolean(),
  })
  .partial();
export type MemoryUpdateRequest = z.infer<typeof memoryUpdateRequestSchema>;

/** GET /api/memories?scope=&botId=&q= (q: full-text search). */
export const memoryListQuerySchema = z.object({
  scope: z.enum(MEMORY_SCOPES).optional(),
  botId: z.string().min(1).optional(),
  q: z.string().trim().max(200).optional(),
});

/** A memory was saved, edited or deleted (by the owner or a bot). Channel: `global`. */
export const liveMemoryChangedSchema = z.object({
  type: z.literal('memory.changed'),
  memoryId: z.string(),
  botId: z.string().nullable(),
});
export type LiveMemoryChanged = z.infer<typeof liveMemoryChangedSchema>;
