'use client';

import type { LiveEvent } from '@agenta/shared';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApprovalList } from '@/components/approvals/approval-card';
import { Button } from '@/components/ui/button';
import { usePendingApprovals } from '@/hooks/use-approvals';
import { useLiveChannel } from '@/hooks/use-live-channel';
import { useNotifications, useReadAllNotifications } from '@/hooks/use-notifications';
import { askDesktopPermissionOnce, showDesktop } from '@/lib/notifications';
import { NotificationList } from './notification-list';

/**
 * Top-bar bell: a badge with pending approvals + unread notifications, and a dropdown to decide approvals and open
 * the latest notifications. It also pops live notifications up on the desktop (permission asked on first open).
 */
export function NotificationsBell() {
  const approvals = usePendingApprovals();
  const notes = useNotifications({ limit: 8 });
  const readAll = useReadAllNotifications();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const waiting = approvals.data?.length ?? 0;
  const unread = notes.data?.unread ?? 0;
  const count = waiting + unread;

  useLiveChannel('global', {
    onEvent: (e: LiveEvent) =>
      e.type === 'notification.changed' && showDesktop(e, (link) => router.push(link)),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const parts = [
    unread ? `${unread} unread` : '',
    waiting ? `${waiting} approval${waiting === 1 ? '' : 's'} waiting` : '',
  ].filter(Boolean);
  const label = parts.length ? `Notifications: ${parts.join(', ')}` : 'Notifications';
  return (
    <div ref={ref} className="relative">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          askDesktopPermissionOnce();
          setOpen(!open);
        }}
        data-testid="notifications-bell"
      >
        <Bell />
        {count > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] dark:bg-red-600 leading-4 font-semibold text-white"
          >
            {count}
          </span>
        )}
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-50 mt-2 max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto rounded-lg border bg-popover p-3 shadow-lg"
        >
          {waiting > 0 && (
            <section aria-label="Approvals">
              <h2 className="mb-2 text-sm font-semibold">Approvals</h2>
              <ApprovalList approvals={approvals.data ?? []} />
            </section>
          )}
          <section aria-label="Inbox">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-semibold">Notifications</h2>
              {unread > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-2 text-xs"
                  onClick={() => readAll.mutate(undefined)}
                >
                  Mark all read
                </Button>
              )}
            </div>
            {notes.data ? (
              <NotificationList items={notes.data.items} onOpen={() => setOpen(false)} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            <Link
              href="/notifications"
              className="mt-2 block text-xs text-muted-foreground hover:underline"
              onClick={() => setOpen(false)}
            >
              See all notifications
            </Link>
          </section>
        </div>
      )}
    </div>
  );
}
