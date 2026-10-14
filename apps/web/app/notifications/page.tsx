import type { Metadata } from 'next';
import { NotificationsView } from '@/components/notifications/notifications-view';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Notifications' };

export default function NotificationsPage() {
  return (
    <Page>
      <PageHeader
        title="Notifications"
        description="Bots finishing, asking you something or getting blocked, approvals, goals, schedules and engine limits."
      />
      <NotificationsView />
    </Page>
  );
}
