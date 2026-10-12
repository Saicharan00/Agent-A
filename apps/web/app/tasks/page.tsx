import { KanbanSquare } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Tasks' };

export default function TasksPage() {
  return (
    <Page>
      <PageHeader title="Tasks" description="Work your team is doing, from todo to done." />
      <EmptyState
        icon={KanbanSquare}
        title="No tasks yet"
        description="Tasks created by you or Agent A show up here (F19)."
      />
    </Page>
  );
}
