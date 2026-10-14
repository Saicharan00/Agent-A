import {
  apiError,
  memoryCreateRequestSchema,
  memoryListQuerySchema,
  memoryUpdateRequestSchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { MemoryError, type MemoryService } from './service';

type IdParams = { Params: { id: string } };

function parse<S extends z.ZodType>(schema: S, value: unknown, reply: FastifyReply, code: string) {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data as z.infer<S>;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  void reply.code(400).send(apiError(code, `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
  return undefined;
}

function handle<T>(reply: FastifyReply, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (err instanceof MemoryError) {
      void reply.code(err.statusCode).send(apiError(err.code, err.message));
      return undefined;
    }
    throw err;
  }
}

/** GET/POST /api/memories, PATCH/DELETE /api/memories/:id. */
export function registerMemoryRoutes(app: FastifyInstance, memories: MemoryService): void {
  app.get('/api/memories', async (req, reply) => {
    const q = parse(memoryListQuerySchema, req.query, reply, 'invalid_query');
    if (q) return memories.list(q);
  });

  app.post('/api/memories', async (req, reply) => {
    const body = parse(memoryCreateRequestSchema, req.body, reply, 'invalid_body');
    if (!body) return;
    const res = handle(reply, () => memories.create(body));
    if (res) return reply.code(201).send(res);
  });

  app.patch<IdParams>('/api/memories/:id', async (req, reply) => {
    const body = parse(memoryUpdateRequestSchema, req.body, reply, 'invalid_body');
    if (body) return handle(reply, () => memories.update(req.params.id, body));
  });

  app.delete<IdParams>('/api/memories/:id', async (req, reply) => {
    handle(reply, () => memories.delete(req.params.id));
    if (!reply.sent) return reply.code(204).send();
  });
}
