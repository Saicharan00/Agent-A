import type { Metadata } from 'next';
import { Page, PageHeader } from '@/components/page-header';
import { SchedulesView } from '@/components/schedules/schedules-view';

export const metadata: Metadata = { title: 'Schedules' };

export default function SchedulesPage() {
  return (
    <Page>
      <PageHeader
        title="Schedules"
        description="Recurring prompts your bots run on a timer, only while the app is running."
      />
      <SchedulesView />
    </Page>
  );
}
