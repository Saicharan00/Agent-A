import { z } from 'zod';
import type { LiveBotsChanged } from './bots';
import type { BotStatusEvent } from './computer';
import { AUTHOR_TYPES, ENGINES, RUN_STATUSES } from './enums';
import { engineEventSchema } from './events';
import type { LiveThreadActivity } from './threads';

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

/**
 * A message was posted (user or bot), or a bot reply grew (on every `text.final` of its run). `authorType` and
 * `createdAt` (F13) let clients add the message to their cache without a refetch.
 */
export const liveMessageSchema = z.object({
  type: z.enum(['message.created', 'message.updated']),
  threadId: z.string(),
  messageId: z.string(),
  runId: z.string().nullable(),
  authorBotId: z.string().nullable(),
  contentMd: z.string(),
  authorType: z.enum(AUTHOR_TYPES).optional(),
  createdAt: z.string().optional(),
});
export type LiveMessage = z.infer<typeof liveMessageSchema>;

/** An engine hit its usage limit (limitedUntil set) or became available again (null). Channel: `global`. */
export const liveEngineStateSchema = z.object({
  type: z.literal('engine.state'),
  engine: z.enum(ENGINES),
  limitedUntil: z.string().nullable(),
});
export type LiveEngineState = z.infer<typeof liveEngineStateSchema>;

/** Docker daemon reachability changed (polled by the runner). Channel: `global`. */
export const liveDockerStateSchema = z.object({
  type: z.literal('docker.state'),
  ok: z.boolean(),
  version: z.string().optional(),
  image: z.boolean().optional(),
  error: z.string().optional(),
});
export type LiveDockerState = z.infer<typeof liveDockerStateSchema>;

export type LiveEvent =
  | LiveRunEvent
  | LiveRunUpdated
  | LiveMessage
  | LiveEngineState
  | LiveDockerState
  | BotStatusEvent
  | LiveBotsChanged
  | LiveThreadActivity;

// ---------- WebSocket wire protocol (GET /ws, F11) ----------
// One socket per browser tab carries any number of channel subscriptions. Every frame is one JSON object.

/** `run:<id>`, `thread:<id>`, `bot:<id>` or `global`. */
export const LIVE_CHANNEL_RE = /^(?:(?:run|thread|bot):[A-Za-z0-9_-]{1,64}|global)$/;
export const liveChannelSchema = z.string().regex(LIVE_CHANNEL_RE, 'unknown channel');

export function isLiveChannel(channel: string): boolean {
  return LIVE_CHANNEL_RE.test(channel);
}

/** The run id of a `run:<id>` channel, else null. */
export function runIdOfChannel(channel: string): string | null {
  return channel.startsWith('run:') ? channel.slice(4) : null;
}

/** Server heartbeat period; clients treat ~2.5 silent periods as a dead connection. */
export const LIVE_HEARTBEAT_MS = 20_000;

/**
 * Client → server. On `run:<id>` channels, `afterSeq` asks the server to replay the run's persisted events after
 * that seq before streaming live ones (0 or omitted = from the start); other channels have no replay.
 */
export const liveClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    channel: liveChannelSchema,
    afterSeq: z.number().int().min(0).optional(),
  }),
  z.object({ type: z.literal('unsubscribe'), channel: liveChannelSchema }),
  z.object({ type: z.literal('ping') }),
]);
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;

/** Server → client. */
export type LiveServerMessage =
  /** A bus event (replayed or live) on a subscribed channel. */
  | { type: 'event'; channel: string; event: LiveEvent }
  /** Subscription is active; for run channels sent after the replay, with the last seq sent and the run status. */
  | { type: 'subscribed'; channel: string; lastSeq?: number; status?: LiveRunUpdated['status'] }
  | { type: 'unsubscribed'; channel: string }
  /** Heartbeat (every LIVE_HEARTBEAT_MS) and the answer to a client ping. */
  | { type: 'ping' | 'pong'; at: string }
  | { type: 'error'; code: string; message: string; channel?: string };

// ---------- GET /api/engines/state ----------

/** Queue state per engine for the top-bar pills; `limitedUntil` is null unless a pause is still in force. */
export const engineQueueStateResponseSchema = z.object({
  /** 'mock' when AGENTA_ENGINE_OVERRIDE forces every bot onto the mock engine (tests, demos). */
  override: z.enum(['mock']).nullable(),
  engines: z.array(z.object({ engine: z.enum(ENGINES), limitedUntil: z.string().nullable() })),
});
export type EngineQueueStateResponse = z.infer<typeof engineQueueStateResponseSchema>;
