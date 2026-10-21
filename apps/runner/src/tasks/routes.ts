import {
  apiError,
  taskCreateRequestSchema,
  taskPatchRequestSchema,
  taskRequestChangesSchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { RunError } from '../runs/service';
import { TaskError, type TaskService } from './service';

type IdParams = { Params: { id: string } };

function parse<S extends z.ZodType>(schema: S, value: unknown, reply: FastifyReply): z.output<S> | undefined {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  void reply
    .code(400)
    .send(apiError('invalid_body', `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
  return undefined;
}

async function handle<T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TaskError || err instanceof RunError) {
      void reply.code(err.statusCode).send(apiError(err.code, err.message));
      return undefined;
    }
    throw err;
  }
}

/** GET/POST /api/tasks, GET/PATCH/DELETE /api/tasks/:id, POST /api/tasks/:id/{start,approve,request-changes}. */
export function registerTaskRoutes(app: FastifyInstance, tasks: TaskService): void {
  app.get('/api/tasks', async () => tasks.list());

  app.post('/api/tasks', async (req, reply) => {
    const body = parse(taskCreateRequestSchema, req.body, reply);
    if (!body) return;
    const res = await handle(reply, () => tasks.create(body));
    if (res) return reply.code(201).send(res);
  });

  app.get<IdParams>('/api/tasks/:id', async (req, reply) => handle(reply, () => tasks.get(req.params.id)));

  app.patch<IdParams>('/api/tasks/:id', async (req, reply) => {
    const body = parse(taskPatchRequestSchema, req.body, reply);
    if (!body) return;
    return handle(reply, () => tasks.update(req.params.id, body));
  });

  app.delete<IdParams>('/api/tasks/:id', async (req, reply) => {
    await handle(reply, () => tasks.delete(req.params.id));
    if (!reply.sent) return reply.code(204).send();
  });

  app.post<IdParams>('/api/tasks/:id/start', async (req, reply) =>
    handle(reply, () => tasks.start(req.params.id)),
  );

  app.post<IdParams>('/api/tasks/:id/approve', async (req, reply) =>
    handle(reply, () => tasks.approve(req.params.id)),
  );

  app.post<IdParams>('/api/tasks/:id/request-changes', async (req, reply) => {
    const body = parse(taskRequestChangesSchema, req.body, reply);
    if (!body) return;
    return handle(reply, () => tasks.requestChanges(req.params.id, body));
  });
}
