import { apiError, scheduleCreateRequestSchema, scheduleUpdateRequestSchema } from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { ScheduleService } from './service';

function parse<S extends z.ZodType>(schema: S, value: unknown, reply: FastifyReply) {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data as z.infer<S>;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  void reply
    .code(400)
    .send(apiError('invalid_body', `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
  return undefined;
}

type Id = { Params: { id: string } };

/**
 * GET/POST /api/schedules, GET/PATCH/DELETE /api/schedules/:id, POST /api/schedules/:id/run (Run now),
 * GET /api/schedules/:id/runs (history). ScheduleErrors carry their status and code for the server's error handler.
 */
export function registerScheduleRoutes(app: FastifyInstance, schedules: ScheduleService): void {
  app.get('/api/schedules', async () => schedules.list());

  app.post('/api/schedules', async (req, reply) => {
    const body = parse(scheduleCreateRequestSchema, req.body, reply);
    if (body) return reply.code(201).send(schedules.create(body));
  });

  app.get<Id>('/api/schedules/:id', async (req) => schedules.get(req.params.id));

  app.patch<Id>('/api/schedules/:id', async (req, reply) => {
    const body = parse(scheduleUpdateRequestSchema, req.body, reply);
    if (body) return schedules.update(req.params.id, body);
  });

  app.delete<Id>('/api/schedules/:id', async (req, reply) => {
    schedules.delete(req.params.id);
    return reply.code(204).send();
  });

  app.post<Id>('/api/schedules/:id/run', async (req) => schedules.runNow(req.params.id));

  app.get<Id>('/api/schedules/:id/runs', async (req) => schedules.history(req.params.id));
}
