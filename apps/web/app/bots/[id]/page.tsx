import { Bot } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Bot' };

export default async function BotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Page>
      <PageHeader title="Bot" description={<span className="font-mono text-xs">{id}</span>} />
      <EmptyState
        icon={Bot}
        title="Bot details arrive in F12"
        description="Profile, instructions, computer and settings."
      />
    </Page>
  );
}
