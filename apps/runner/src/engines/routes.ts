import type { EngineSettingsResponse } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EngineAuth } from './auth';

const querySchema = z.object({ verify: z.enum(['0', '1', 'true', 'false']).optional() });

/** GET /api/settings/engines[?verify=1]: auth status per engine. Never returns secret values. */
export function registerEngineRoutes(app: FastifyInstance, auth: EngineAuth): void {
  app.get('/api/settings/engines', async (req, reply): Promise<EngineSettingsResponse | undefined> => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      void reply.code(400).send({ error: { code: 'invalid_query', message: 'verify must be 0 or 1' } });
      return undefined;
    }
    const verify = parsed.data.verify === '1' || parsed.data.verify === 'true';
    return { engines: await auth.statuses({ verify }) };
  });
}
