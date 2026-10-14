import { apiError, connectorPatchSchema } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import type { ConnectorService } from './service';

/** GET /api/connectors, PATCH /api/connectors/:id {enabled?, botIds?}. */
export function registerConnectorRoutes(app: FastifyInstance, connectors: ConnectorService): void {
  app.get('/api/connectors', async () => connectors.list());

  app.patch<{ Params: { id: string } }>('/api/connectors/:id', async (req, reply) => {
    const parsed = connectorPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join('.');
      return reply
        .code(400)
        .send(apiError('invalid_body', `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
    }
    // A ConnectorError carries its status and code; the server's error handler sends it as a typed error.
    return connectors.update(req.params.id, parsed.data);
  });
}
