import { GraduationCap } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Learn' };

export default function LearnPage() {
  return (
    <Page>
      <PageHeader title="Learn" description="Decisions, lessons and how the work was split." />
      <EmptyState
        icon={GraduationCap}
        title="Nothing to review yet"
        description="Lessons and decision records arrive in F23."
      />
    </Page>
  );
}
