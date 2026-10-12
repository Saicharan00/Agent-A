import { CalendarClock } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Schedules' };

export default function SchedulesPage() {
  return (
    <Page>
      <PageHeader title="Schedules" description="Recurring prompts your bots run on a timer." />
      <EmptyState icon={CalendarClock} title="No schedules" description="Scheduled tasks arrive in F26." />
    </Page>
  );
}
