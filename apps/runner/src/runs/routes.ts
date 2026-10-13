import type { Run, RunEvent } from '@agenta/db';
import { apiError, runEventsQuerySchema, runListQuerySchema } from '@agenta/shared';
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
