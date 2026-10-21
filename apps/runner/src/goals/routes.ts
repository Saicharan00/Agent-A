import { apiError, goalCreateRequestSchema, goalPatchRequestSchema } from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { RunError } from '../runs/service';
import { TaskError } from '../tasks/service';
import { ThreadError } from '../threads/service';
import { GoalError, type GoalService } from './service';

type IdParams = { Params: { id: string } };

async function handle<T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (
      err instanceof GoalError ||
      err instanceof RunError ||
      err instanceof TaskError ||
      err instanceof ThreadError
    ) {
      void reply.code(err.statusCode).send(apiError(err.code, err.message));
      return undefined;
    }
    throw err;
  }
}

/** GET/POST /api/goals, GET/PATCH/DELETE /api/goals/:id, POST /api/goals/:id/{confirm,pause,resume}. */
export function registerGoalRoutes(app: FastifyInstance, goals: GoalService): void {
  app.get('/api/goals', async () => goals.list());

  app.post('/api/goals', async (req, reply) => {
    const parsed = goalCreateRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.');
      return reply
        .code(400)
        .send(apiError('invalid_body', `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
    }
    const res = await handle(reply, () => goals.create(parsed.data));
    if (res) return reply.code(201).send(res);
  });

  app.get<IdParams>('/api/goals/:id', async (req, reply) => handle(reply, () => goals.get(req.params.id)));
  app.patch<IdParams>('/api/goals/:id', async (req, reply) => {
    const parsed = goalPatchRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send(apiError('invalid_body', `${issue?.path.join('.')}: ${issue?.message}`));
    }
    return handle(reply, () => goals.setBudget(req.params.id, parsed.data));
  });
  app.delete<IdParams>('/api/goals/:id', async (req, reply) => {
    await handle(reply, () => goals.delete(req.params.id));
    if (!reply.sent) return reply.code(204).send();
  });
  app.post<IdParams>('/api/goals/:id/confirm', async (req, reply) =>
    handle(reply, () => goals.confirm(req.params.id)),
  );
  app.post<IdParams>('/api/goals/:id/pause', async (req, reply) =>
    handle(reply, () => goals.pause(req.params.id)),
  );
  app.post<IdParams>('/api/goals/:id/resume', async (req, reply) =>
    handle(reply, () => goals.resume(req.params.id)),
  );
}
