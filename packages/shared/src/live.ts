import { z } from 'zod';
import { ENGINES, RUN_STATUSES } from './enums';
import { engineEventSchema } from './events';

// What the runner publishes on the event bus for runs (F10). F11 fans these out over WebSocket on the
// `run:<id>`, `thread:<id>`, `bot:<id>` and `global` channels.

/** One persisted engine event, with its per-run sequence number (replay with GET /runs/:id/events?afterSeq=). */
export const liveRunEventSchema = z.object({
  type: z.literal('run.event'),
  runId: z.string(),
  seq: z.number().int().positive(),
  event: engineEventSchema,
  createdAt: z.string(),
});
export type LiveRunEvent = z.infer<typeof liveRunEventSchema>;

/** A run's row changed status (queued → running → finished, or re-queued). */
export const liveRunUpdatedSchema = z.object({
  type: z.literal('run.updated'),
  runId: z.string(),
  botId: z.string(),
  threadId: z.string().nullable(),
  taskId: z.string().nullable(),
  status: z.enum(RUN_STATUSES),
  error: z.string().nullable(),
});
export type LiveRunUpdated = z.infer<typeof liveRunUpdatedSchema>;

/** A bot reply was created or grew (on every `text.final` of its run). */
export const liveMessageSchema = z.object({
  type: z.enum(['message.created', 'message.updated']),
  threadId: z.string(),
  messageId: z.string(),
  runId: z.string().nullable(),
  authorBotId: z.string().nullable(),
  contentMd: z.string(),
});
export type LiveMessage = z.infer<typeof liveMessageSchema>;

/** An engine hit its usage limit (limitedUntil set) or became available again (null). Channel: `global`. */
export const liveEngineStateSchema = z.object({
  type: z.literal('engine.state'),
  engine: z.enum(ENGINES),
  limitedUntil: z.string().nullable(),
});
export type LiveEngineState = z.infer<typeof liveEngineStateSchema>;

export type LiveEvent = LiveRunEvent | LiveRunUpdated | LiveMessage | LiveEngineState;
