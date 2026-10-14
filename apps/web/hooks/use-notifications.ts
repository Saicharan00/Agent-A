'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { notificationsApi } from '@/lib/notifications';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

/** Newest first, with the unread count; kept fresh by the live `notification.changed` event. */
export function useNotifications(opts: { unread?: boolean; limit?: number } = {}) {
  const unread = opts.unread ?? false;
  const limit = opts.limit ?? 100;
  return useQuery({
    queryKey: queryKeys.notificationList(unread, limit),
    queryFn: () => notificationsApi.list({ unread, limit }),
  });
}

function useInvalidating<T>(fn: (arg: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.notifications }),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Something went wrong'),
  });
}

export const useReadNotification = () => useInvalidating((id: string) => notificationsApi.read(id));
export const useReadAllNotifications = () => useInvalidating(() => notificationsApi.readAll());
