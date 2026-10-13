import { apiError } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import { ContainerError } from '../containers/manager';
import { allowedOrigins } from '../live/routes';
import type { TerminalSocket } from '../terminal/service';
import type { DesktopService } from './service';

/** GET /ws/desktop/:botId (the bot's noVNC stream) and POST /api/bots/:id/computer/screenshot (F16). Needs @fastify/websocket registered. */
export function registerDesktopRoutes(
  app: FastifyInstance,
  desktops: DesktopService,
  opts: { webOrigin: string },
): void {
  // Same origin rule as the terminal: taking control of a desktop is as powerful as a shell.
  const origins = allowedOrigins(opts.webOrigin);
  app.addHook('onClose', async () => desktops.close());
  app.post<{ Params: { id: string } }>('/api/bots/:id/computer/screenshot', async (req, reply) => {
    try {
      return await desktops.screenshot(req.params.id);
    } catch (err) {
      if (err instanceof ContainerError)
        return reply.code(err.statusCode).send(apiError(err.code, err.message));
      throw err;
    }
  });
  app.get<{ Params: { botId: string } }>(
    '/ws/desktop/:botId',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) {
          req.log.warn({ origin }, 'desktop socket rejected: foreign origin');
          return reply.code(403).send(apiError('forbidden_origin', 'This origin may not open a desktop'));
        }
      },
    },
    (socket, req) => {
      void desktops.handle(socket as unknown as TerminalSocket, req.params.botId);
    },
  );
}
