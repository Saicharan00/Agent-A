import { MessagesSquare } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Thread' };

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Page>
      <PageHeader title="Thread" description={<span className="font-mono text-xs">{id}</span>} />
      <EmptyState
        icon={MessagesSquare}
        title="Chat arrives in F13"
        description="Messages, streamed replies and tool-call cards will appear here."
      />
    </Page>
  );
}
