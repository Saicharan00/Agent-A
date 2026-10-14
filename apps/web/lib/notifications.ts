// Notifications & activity inbox (F27): the owner's inbox and browser desktop notifications.
import {
  type LiveNotificationChanged,
  notificationListResponseSchema,
  notificationViewSchema,
} from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';
import { STORAGE_KEYS, readBool, writeBool } from './storage';

export const notificationsApi = {
  list: (opts: { unread?: boolean; limit?: number } = {}) =>
    apiRequest('/notifications', notificationListResponseSchema, {
      query: { unread: opts.unread ? '1' : undefined, limit: opts.limit },
    }),
  read: (id: string) =>
    apiRequest(`/notifications/${encodeURIComponent(id)}/read`, notificationViewSchema, { method: 'POST' }),
  readAll: () => apiRequest('/notifications/read-all', z.object({ marked: z.number() }), { method: 'POST' }),
};

function desktopSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** Asks for desktop notification permission the first time only (the browser remembers the answer). */
export function askDesktopPermissionOnce(): void {
  if (!desktopSupported() || Notification.permission !== 'default') return;
  if (readBool(STORAGE_KEYS.desktopAsked, false)) return;
  writeBool(STORAGE_KEYS.desktopAsked, true);
  void Notification.requestPermission().catch(() => undefined);
}

/** Pops up a live notification on the desktop when the runner says so and the owner allowed it. */
export function showDesktop(event: LiveNotificationChanged, open: (link: string) => void): void {
  const n = event.notification;
  if (!n || !event.desktop || !desktopSupported() || Notification.permission !== 'granted') return;
  try {
    const popup = new Notification(n.title, { body: n.body.slice(0, 200), tag: n.id });
    popup.onclick = () => {
      window.focus();
      if (n.link) open(n.link);
      popup.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the in-app inbox still has it.
  }
}
