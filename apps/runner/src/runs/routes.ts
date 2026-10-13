import type { Run, RunEvent } from '@agenta/db';
import {
  ENGINES,
  type EngineQueueStateResponse,
  type RunEventsBatchResponse,
  apiError,
  compactRunEvents,
  engineEventSchema,
  nowIso,
  runEventsBatchQuerySchema,
  runEventsQuerySchema,
  runListQuerySchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { RunError, type RunService } from './service';

type IdParams = { Params: { id: string } };

export type RunEventsResponse = { runId: string; status: Run['status']; events: RunEvent[] };

function parse<S extends z.ZodType>(schema: S, value: unknown, reply: FastifyReply): z.output<S> | undefined {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  void reply
    .code(400)
    .send(apiError('invalid_query', `${issue?.path.join('.') || 'query'}: ${issue?.message ?? 'invalid'}`));
  return undefined;
}

/** GET /api/runs, GET /api/runs/:id, GET /api/runs/:id/events?afterSeq=, POST /api/runs/:id/cancel */
export function registerRunRoutes(app: FastifyInstance, runs: RunService): void {
  const repos = () => app.repos!;

  app.get('/api/runs', async (req, reply) => {
    const q = parse(runListQuerySchema, req.query, reply);
    if (!q) return;
    return repos().runs.list(q);
  });

  // Chat transcripts: several finished runs' timelines in one request, compacted for display. Unknown ids are omitted.
  app.get('/api/runs/events', async (req, reply): Promise<RunEventsBatchResponse | undefined> => {
    const q = parse(runEventsBatchQuerySchema, req.query, reply);
    if (!q) return;
    const out: RunEventsBatchResponse['runs'] = {};
    for (const id of q.ids) {
      const run = repos().runs.get(id);
      if (!run) continue;
      const items = repos()
        .runs.listEvents(id, 0, 10_000)
        .flatMap((row) => {
          // Rows written by older code may not match today's schema; skip them rather than fail the transcript.
          const parsed = engineEventSchema.safeParse(row.payload);
          return parsed.success ? [{ seq: row.seq, event: parsed.data }] : [];
        });
      out[id] = { status: run.status, events: compactRunEvents(items) };
    }
    return { runs: out };
  });

  app.get<IdParams>('/api/runs/:id', async (req, reply) => {
    const run = repos().runs.get(req.params.id);
    if (!run) return reply.code(404).send(apiError('run_not_found', `Run ${req.params.id} not found`));
    return run;
  });

  // Replay: a client that saw up to seq N asks for afterSeq=N and gets the rest in order.
  app.get<IdParams>('/api/runs/:id/events', async (req, reply): Promise<RunEventsResponse | undefined> => {
    const q = parse(runEventsQuerySchema, req.query, reply);
    if (!q) return;
    const run = repos().runs.get(req.params.id);
    if (!run) {
      void reply.code(404).send(apiError('run_not_found', `Run ${req.params.id} not found`));
      return;
    }
    return {
      runId: run.id,
      status: run.status,
      events: repos().runs.listEvents(run.id, q.afterSeq, q.limit),
    };
  });

  app.post<IdParams>('/api/runs/:id/cancel', async (req, reply) => {
    try {
      return await runs.cancel(req.params.id);
    } catch (err) {
      if (err instanceof RunError) return reply.code(err.statusCode).send(apiError(err.code, err.message));
      throw err;
    }
  });
}

/** GET /api/engines/state: usage-limit pauses per engine (top-bar pills) and the engine override, if any. */
export function registerEngineStateRoute(app: FastifyInstance, override: 'mock' | undefined): void {
  app.get('/api/engines/state', async (): Promise<EngineQueueStateResponse> => {
    const now = nowIso();
    const rows = new Map(app.repos!.engineState.list().map((r) => [r.engine, r.limitedUntil]));
    return {
      override: override ?? null,
      engines: ENGINES.map((engine) => {
        const until = rows.get(engine) ?? null;
        return { engine, limitedUntil: until && until > now ? until : null };
      }),
    };
  });
}
