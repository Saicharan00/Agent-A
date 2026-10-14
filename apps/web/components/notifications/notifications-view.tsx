'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useNotifications, useReadAllNotifications } from '@/hooks/use-notifications';
import { NotificationList } from './notification-list';

/** The full inbox: all or unread only, and mark all read. */
export function NotificationsView() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data } = useNotifications({ unread: unreadOnly, limit: 200 });
  const readAll = useReadAllNotifications();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2" role="group" aria-label="Filter">
        <Button size="sm" variant={unreadOnly ? 'ghost' : 'secondary'} onClick={() => setUnreadOnly(false)}>
          All
        </Button>
        <Button size="sm" variant={unreadOnly ? 'secondary' : 'ghost'} onClick={() => setUnreadOnly(true)}>
          Unread{data?.unread ? ` (${data.unread})` : ''}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={!data?.unread || readAll.isPending}
          onClick={() => readAll.mutate(undefined)}
        >
          Mark all read
        </Button>
      </div>
      {data ? (
        <NotificationList
          items={data.items}
          empty={unreadOnly ? 'No unread notifications.' : 'No notifications yet.'}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
