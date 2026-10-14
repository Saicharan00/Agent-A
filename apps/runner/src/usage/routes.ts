import {
  type UsageReport,
  type UsageSettings,
  apiError,
  usageQuerySchema,
  usageSettingsSchema,
} from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import type { RunService } from '../runs/service';
import { buildUsageReport, readUsageSettings, writeUsageSettings } from './service';

/** GET /api/usage?days=&tz=, GET/PUT /api/usage/settings. */
export function registerUsageRoutes(app: FastifyInstance, runs: RunService): void {
  app.get('/api/usage', async (req, reply): Promise<UsageReport | undefined> => {
    const q = usageQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      const issue = q.error.issues[0];
      void reply.code(400).send(apiError('invalid_query', `${issue?.path.join('.')}: ${issue?.message}`));
      return;
    }
    return buildUsageReport(app.repos!, runs, q.data);
  });

  app.get('/api/usage/settings', async (): Promise<UsageSettings> => readUsageSettings(runs));

  app.put('/api/usage/settings', async (req, reply): Promise<UsageSettings | undefined> => {
    const body = usageSettingsSchema.safeParse(req.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      void reply.code(400).send(apiError('invalid_body', `${issue?.path.join('.')}: ${issue?.message}`));
      return;
    }
    return writeUsageSettings(app.repos!, runs, body.data);
  });
}
