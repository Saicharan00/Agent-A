'use client';

import Link from 'next/link';
import { useNotifications } from '@/hooks/use-notifications';
import { NotificationList } from './notification-list';

/** Home: the latest activity (notifications, read or not). Hidden until there is some. */
export function HomeActivity() {
  const { data } = useNotifications({ limit: 8 });
  if (!data?.items.length) return null;
  return (
    <section className="space-y-2" aria-labelledby="home-activity-title">
      <div className="flex items-center">
        <h2 id="home-activity-title" className="text-sm font-semibold">
          Recent activity
        </h2>
        <Link href="/notifications" className="ml-auto text-xs text-muted-foreground hover:underline">
          See all
        </Link>
      </div>
      <NotificationList items={data.items} />
    </section>
  );
}
