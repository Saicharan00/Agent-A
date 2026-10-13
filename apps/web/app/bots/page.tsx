import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BotsGrid } from '@/components/bots/bots-grid';
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
      <BotsGrid />
    </Page>
  );
}
