import { Bot, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';

export const metadata: Metadata = { title: 'Bots' };

export default function BotsPage() {
  return (
    <Page>
      <PageHeader
        title="Bots"
        description="Your AI teammates. Each one has its own sandboxed computer."
        actions={
          <Link href="/bots/new" className={buttonVariants({ size: 'sm' })}>
            <Plus /> New bot
          </Link>
        }
      />
      <EmptyState
        icon={Bot}
        title="No bots yet"
        description="Create your first bot to start a conversation."
      />
    </Page>
  );
}
