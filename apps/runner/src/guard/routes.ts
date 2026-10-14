import { apiError, guardCheckRequestSchema, guardTermCreateSchema } from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { GuardService } from './service';

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

/** POST /api/guard/check, GET/POST /api/guard/terms, DELETE /api/guard/terms/:id. */
export function registerGuardRoutes(app: FastifyInstance, guard: GuardService): void {
  app.post('/api/guard/check', async (req, reply) => {
    const body = parse(guardCheckRequestSchema, req.body, reply);
    if (body) return guard.check(body.text);
  });

  app.get('/api/guard/terms', async () => guard.listTerms());

  app.post('/api/guard/terms', async (req, reply) => {
    const body = parse(guardTermCreateSchema, req.body, reply);
    if (body) return reply.code(201).send(guard.createTerm(body));
  });

  app.delete<{ Params: { id: string } }>('/api/guard/terms/:id', async (req, reply) => {
    // A GuardError carries its status and code; the server's error handler sends it as a typed error.
    guard.deleteTerm(req.params.id);
    return reply.code(204).send();
  });
}
