import { apiError, notificationListQuerySchema } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import type { NotificationService } from './service';

/** GET /api/notifications?unread=1&limit=, POST /api/notifications/:id/read, POST /api/notifications/read-all. */
export function registerNotificationRoutes(app: FastifyInstance, notifications: NotificationService): void {
  app.get('/api/notifications', async (req, reply) => {
    const q = notificationListQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      const issue = q.error.issues[0];
      return reply
        .code(400)
        .send(
          apiError('invalid_query', `${issue?.path.join('.') || 'query'}: ${issue?.message ?? 'invalid'}`),
        );
    }
    return notifications.list(q.data);
  });

  app.post('/api/notifications/read-all', async () => notifications.readAll());

  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req, reply) => {
    const n = notifications.read(req.params.id);
    if (!n)
      return reply
        .code(404)
        .send(apiError('notification_not_found', `Notification ${req.params.id} not found`));
    return n;
  });
}
