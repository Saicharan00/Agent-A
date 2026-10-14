import type { Metadata } from 'next';
import { LearnView } from '@/components/learn/learn-view';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Learn' };

export default function LearnPage() {
  return (
    <Page>
      <PageHeader
        title="Learn"
        description="Why the team decided what it decided, and the lessons worth reviewing until they stick."
      />
      <LearnView />
    </Page>
  );
}
