import {
  apiError,
  botMcpAccessPutSchema,
  mcpServerCreateSchema,
  mcpServerUpdateSchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { GatewayService } from './service';

function parse<S extends z.ZodType>(schema: S, body: unknown, reply: FastifyReply): z.output<S> | undefined {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  void reply
    .code(400)
    .send(apiError('invalid_body', `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
  return undefined;
}

/**
 * MCP gateway (F35): /api/mcp-servers (CRUD + POST /:id/test) and /api/bots/:id/mcp-access (GET, PUT {access}).
 * A GatewayError carries its status and code; the server's error handler sends it as a typed error.
 */
export function registerGatewayRoutes(app: FastifyInstance, gateway: GatewayService): void {
  app.get('/api/mcp-servers', async () => gateway.list());

  app.post('/api/mcp-servers', async (req, reply) => {
    const body = parse(mcpServerCreateSchema, req.body, reply);
    if (!body) return reply;
    return reply.code(201).send(gateway.create(body));
  });

  app.get<{ Params: { id: string } }>('/api/mcp-servers/:id', async (req) => gateway.get(req.params.id));

  app.patch<{ Params: { id: string } }>('/api/mcp-servers/:id', async (req, reply) => {
    const body = parse(mcpServerUpdateSchema, req.body, reply);
    if (!body) return reply;
    return gateway.update(req.params.id, body);
  });

  app.delete<{ Params: { id: string } }>('/api/mcp-servers/:id', async (req, reply) => {
    await gateway.remove(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/test', async (req) =>
    gateway.test(req.params.id),
  );

  app.get<{ Params: { id: string } }>('/api/bots/:id/mcp-access', async (req) =>
    gateway.accessFor(req.params.id),
  );

  app.put<{ Params: { id: string } }>('/api/bots/:id/mcp-access', async (req, reply) => {
    const body = parse(botMcpAccessPutSchema, req.body, reply);
    if (!body) return reply;
    return gateway.setAccess(req.params.id, body.access);
  });
}
