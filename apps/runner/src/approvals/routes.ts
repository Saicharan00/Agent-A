import { apiError, approvalDecideRequestSchema, approvalListQuerySchema } from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { ApprovalService } from './service';

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

/** GET /api/approvals?status=, GET /api/approvals/:id, POST /api/approvals/:id/decide. */
export function registerApprovalRoutes(app: FastifyInstance, approvals: ApprovalService): void {
  app.get('/api/approvals', async (req, reply) => {
    const q = parse(approvalListQuerySchema, req.query, reply);
    if (q) return approvals.list(q.status);
  });

  // An ApprovalError carries its status and code; the server's error handler sends it as a typed error.
  app.get<{ Params: { id: string } }>('/api/approvals/:id', async (req) => approvals.get(req.params.id));

  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (req, reply) => {
    const body = parse(approvalDecideRequestSchema, req.body, reply);
    if (body) return approvals.decide(req.params.id, body);
  });
}
