import { z } from 'zod';
import { ENGINES } from './enums';

// Normalized engine events (PLAN §2). Every adapter converts its CLI's output into these; they are stored in
// run_events (type + payload) and fanned out over WebSocket. Keep additive: old rows must still parse.

export const RUN_FINISH_STATUSES = ['succeeded', 'failed', 'cancelled', 'limited'] as const;
export const FILE_CHANGES = ['created', 'modified', 'deleted'] as const;

export const engineEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), engine: z.enum(ENGINES), sessionId: z.string().optional() }),
  /** Streamed assistant text (append to the current message). */
  z.object({ type: z.literal('text.delta'), text: z.string() }),
  /** A complete assistant message (replaces the deltas streamed so far for it). */
  z.object({ type: z.literal('text.final'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('tool.call'), callId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    type: z.literal('tool.result'),
    callId: z.string(),
    output: z.string(),
    isError: z.boolean().optional(),
  }),
  z.object({ type: z.literal('file.changed'), path: z.string(), change: z.enum(FILE_CHANGES) }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    costUsdEquivalent: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('limit.hit'),
    engine: z.string(),
    resetsAt: z.string().optional(),
    raw: z.string(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    raw: z.string().optional(),
    /** `exec_failed`: the engine could not be started in the computer (the orchestrator retries once). */
    code: z.string().optional(),
  }),
  /** A note from the platform about the run itself (e.g. "previous session not found, started a new one"). */
  z.object({ type: z.literal('system'), message: z.string() }),
  z.object({
    type: z.literal('run.finished'),
    status: z.enum(RUN_FINISH_STATUSES),
    sessionId: z.string().optional(),
  }),
]);

export type EngineEvent = z.infer<typeof engineEventSchema>;
export type EngineEventType = EngineEvent['type'];
export type EngineEventOf<T extends EngineEventType> = Extract<EngineEvent, { type: T }>;
export type RunFinishStatus = (typeof RUN_FINISH_STATUSES)[number];
