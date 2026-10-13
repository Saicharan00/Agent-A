import { apiError, terminalQuerySchema } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import { allowedOrigins } from '../live/routes';
import type { TerminalService, TerminalSocket } from './service';

type Req = { Params: { botId: string }; Querystring: Record<string, string> };

/** GET /ws/terminal/:botId?cols=&rows=: a raw TTY in the bot's computer. Needs @fastify/websocket registered. */
export function registerTerminalRoutes(
  app: FastifyInstance,
  terminals: TerminalService,
  opts: { webOrigin: string },
): void {
  // Same origin rule as /ws: a shell in a bot's computer must never be reachable from another site's page.
  const origins = allowedOrigins(opts.webOrigin);
  app.addHook('onClose', async () => terminals.close());
  app.get<Req>(
    '/ws/terminal/:botId',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) {
          req.log.warn({ origin }, 'terminal socket rejected: foreign origin');
          return reply.code(403).send(apiError('forbidden_origin', 'This origin may not open a terminal'));
        }
        const query = terminalQuerySchema.safeParse(req.query);
        if (!query.success) {
          const issue = query.error.issues[0];
          return reply
            .code(400)
            .send(apiError('invalid_query', `${issue?.path.join('.')}: ${issue?.message ?? 'invalid'}`));
        }
      },
    },
    (socket, req) => {
      const size = terminalQuerySchema.parse(req.query);
      void terminals.handle(socket as unknown as TerminalSocket, req.params.botId, size);
    },
  );
}
