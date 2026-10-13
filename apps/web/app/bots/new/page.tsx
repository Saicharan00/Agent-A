import type { Metadata } from 'next';
import { NewBot } from '@/components/bots/new-bot';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'New bot' };

export default function NewBotPage() {
  return (
    <Page>
      <PageHeader
        title="New bot"
        description="Name, role, engine and instructions. Its computer is created the first time it works."
      />
      <NewBot />
    </Page>
  );
}
