import {
  apiError,
  botMcpAccessPutSchema,
  mcpServerCreateRequestSchema,
  mcpServerUpdateSchema,
  researchSettingsSchema,
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
 * MCP gateway (F35): /api/mcp-servers (CRUD + POST /:id/test; POST takes {server, grantTo?}),
 * /api/bots/:id/mcp-access (GET, PUT {access}) and /api/research/settings (GET, PUT {webAccess}).
 * A GatewayError carries its status and code; the server's error handler sends it as a typed error.
 */
export function registerGatewayRoutes(app: FastifyInstance, gateway: GatewayService): void {
  app.get('/api/mcp-servers', async () => gateway.list());

  app.post('/api/mcp-servers', async (req, reply) => {
    const body = parse(mcpServerCreateRequestSchema, req.body, reply);
    if (!body) return reply;
    return reply.code(201).send(gateway.create(body.server, body.grantTo));
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

  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/oauth', async (req) =>
    gateway.oauthStart(req.params.id),
  );

  app.delete<{ Params: { id: string } }>('/api/mcp-servers/:id/oauth', async (req) =>
    gateway.oauthSignOut(req.params.id),
  );

  // The owner's browser returns here from the server's sign-in page (via the web app's /api proxy).
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/api/mcp-oauth/callback',
    async (req, reply) => {
      const { state, code, error } = req.query;
      let result: string;
      if (error || !state || !code) result = `error=${encodeURIComponent(error ?? 'missing code')}`;
      else {
        try {
          const s = await gateway.oauthCallback(state, code);
          result = s.lastError
            ? `error=${encodeURIComponent('connected but the test failed')}`
            : `signed-in=${s.slug}`;
        } catch (err) {
          result = `error=${encodeURIComponent((err as Error).message.slice(0, 300))}`;
        }
      }
      return reply.redirect(`/settings/mcp?oauth&${result}`);
    },
  );

  app.get('/api/research/settings', async () => gateway.research());

  app.put('/api/research/settings', async (req, reply) => {
    const body = parse(researchSettingsSchema, req.body, reply);
    if (!body) return reply;
    return gateway.setResearch(body.webAccess);
  });

  app.get<{ Params: { id: string } }>('/api/bots/:id/mcp-access', async (req) =>
    gateway.accessFor(req.params.id),
  );

  app.put<{ Params: { id: string } }>('/api/bots/:id/mcp-access', async (req, reply) => {
    const body = parse(botMcpAccessPutSchema, req.body, reply);
    if (!body) return reply;
    return gateway.setAccess(req.params.id, body.access);
  });
}
