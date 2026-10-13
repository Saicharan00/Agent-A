import websocket from '@fastify/websocket';
import { apiError } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import type { LiveHub, LiveSocket } from './hub';

/**
 * Browsers send an Origin on WebSocket upgrades but apply no CORS to them, so any page the owner visits could
 * otherwise open ws://localhost:3000/ws. Accept the web app's origin (and its localhost/127.0.0.1 aliases on the
 * same port); requests without an Origin come from local non-browser clients (tests, scripts) and are allowed.
 */
export function allowedOrigins(webOrigin: string): Set<string> {
  const url = new URL(webOrigin);
  const port = url.port ? `:${url.port}` : '';
  const out = new Set([url.origin]);
  for (const host of ['localhost', '127.0.0.1', '[::1]']) out.add(`${url.protocol}//${host}${port}`);
  return out;
}

/** GET /ws: the live event socket (subscribe/unsubscribe to channels; see packages/shared/src/live.ts). */
export async function registerLiveRoutes(
  app: FastifyInstance,
  hub: LiveHub,
  opts: { webOrigin: string },
): Promise<void> {
  const origins = allowedOrigins(opts.webOrigin);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addHook('onClose', async () => hub.close());
  app.get(
    '/ws',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        if (origin && !origins.has(origin)) {
          req.log.warn({ origin }, 'live socket rejected: foreign origin');
          return reply
            .code(403)
            .send(apiError('forbidden_origin', 'This origin may not open the live socket'));
        }
      },
    },
    (socket) => hub.handle(socket as unknown as LiveSocket),
  );
}
