import { Bot } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'New bot' };

export default function NewBotPage() {
  return (
    <Page>
      <PageHeader title="New bot" description="Name, role, engine and instructions." />
      <EmptyState
        icon={Bot}
        title="Bot creation arrives in F12"
        description="The form will create a bot and its computer."
      />
    </Page>
  );
}
