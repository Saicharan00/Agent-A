'use client';

import type { NotificationView } from '@agenta/shared';
import Link from 'next/link';
import { BotAvatar } from '@/components/bot-avatar';
import { useBots } from '@/hooks/use-bots';
import { useReadNotification } from '@/hooks/use-notifications';
import { relativeTime } from '@/lib/bots';
import { cn } from '@/lib/utils';

/** Notifications, newest first. Opening one marks it read and follows its link. */
export function NotificationList({
  items,
  onOpen,
  empty = 'Nothing new.',
}: {
  items: NotificationView[];
  onOpen?: () => void;
  empty?: string;
}) {
  const bots = useBots('include');
  const read = useReadNotification();
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y rounded-lg border bg-card" aria-label="Notifications">
      {items.map((n) => {
        const bot = n.botId ? bots.data?.find((b) => b.id === n.botId) : undefined;
        const unread = !n.readAt;
        const open = () => {
          if (unread) read.mutate(n.id);
          onOpen?.();
        };
        const content = (
          <>
            {bot ? (
              <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} size="sm" />
            ) : (
              <span className="size-7 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-sm', unread && 'font-semibold')}>{n.title}</span>
              {n.body && <span className="line-clamp-2 text-xs text-muted-foreground">{n.body}</span>}
              <span className="text-xs text-muted-foreground" title={new Date(n.createdAt).toLocaleString()}>
                {relativeTime(n.createdAt)}
              </span>
            </span>
            {unread && (
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-label="unread" />
            )}
          </>
        );
        const cls = 'flex w-full items-start gap-2 p-2 text-left hover:bg-accent';
        return (
          <li key={n.id} data-testid="notification" data-unread={unread || undefined}>
            {n.link ? (
              <Link href={n.link} className={cls} onClick={open}>
                {content}
              </Link>
            ) : (
              <button type="button" className={cls} onClick={open}>
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
