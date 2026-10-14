// Notifications & activity inbox (F27): what the owner should see soon, the inbox API and the live event.
import { z } from 'zod';
import type { NotificationLevel } from './enums';

/** Kinds that need the owner; a bot set to "mentions" only raises desktop notifications for these. */
export const OWNER_NOTIFICATION_KINDS = [
  'bot.question',
  'bot.notice',
  'approval.requested',
  'task.review',
  'task.blocked',
  'task.escalated',
  'goal.blocked',
] as const;

/** Whether a notification of `kind` about a bot with `level` should also pop up on the desktop. */
export function wantsDesktop(kind: string, level: NotificationLevel | null): boolean {
  if (level === 'none') return false;
  if (level === 'mentions') return (OWNER_NOTIFICATION_KINDS as readonly string[]).includes(kind);
  return true;
}

export const notificationViewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string().nullable(),
  botId: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

/** GET /api/notifications?unread=1&limit= */
export const notificationListQuerySchema = z.object({
  unread: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type NotificationListQuery = z.input<typeof notificationListQuerySchema>;

export const notificationListResponseSchema = z.object({
  items: z.array(notificationViewSchema),
  unread: z.number().int().min(0),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

/**
 * A notification was created (`notification` set; `desktop` says whether to pop it up) or some were marked read
 * (`notification` null). Channel: `global`.
 */
export const liveNotificationChangedSchema = z.object({
  type: z.literal('notification.changed'),
  notification: notificationViewSchema.nullable(),
  desktop: z.boolean(),
});
export type LiveNotificationChanged = z.infer<typeof liveNotificationChangedSchema>;
