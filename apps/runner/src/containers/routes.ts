import { apiError, computerResetSchema } from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ContainerError, type ContainerManager } from './manager';

type IdParams = { Params: { id: string } };

async function handle<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ContainerError) {
      void reply.code(err.statusCode).send(apiError(err.code, err.message));
      return undefined;
    }
    const code = (err as { code?: unknown }).code;
    if (code === 'ECONNREFUSED' || code === 'ENOENT' || code === 'EACCES') {
      void reply.code(503).send(apiError('docker_unavailable', 'Docker is not reachable from the runner'));
      return undefined;
    }
    throw err;
  }
}

/** /api/bots/:id/computer[/start|/stop|/reset] */
export function registerComputerRoutes(app: FastifyInstance, manager: ContainerManager): void {
  app.get<IdParams>('/api/bots/:id/computer', (req, reply) =>
    handle(reply, () => manager.status(req.params.id)),
  );

  app.post<IdParams>('/api/bots/:id/computer/start', (req, reply) =>
    handle(reply, () => manager.start(req.params.id)),
  );

  app.post<IdParams>('/api/bots/:id/computer/stop', (req, reply) =>
    handle(reply, () => manager.stop(req.params.id)),
  );

  app.post<IdParams>('/api/bots/:id/computer/reset', async (req, reply) => {
    const parsed = computerResetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const code = issue?.path[0] === 'confirm' ? 'confirm_required' : 'invalid_body';
      return reply.code(400).send(apiError(code, issue?.message ?? 'Invalid body'));
    }
    return handle(reply, () => manager.reset(req.params.id, { wipeHome: parsed.data.wipeHome }));
  });
}
