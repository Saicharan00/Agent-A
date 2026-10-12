import { BarChart3 } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Usage' };

export default function UsagePage() {
  return (
    <Page>
      <PageHeader title="Usage" description="Runs, tokens and subscription limits per engine." />
      <EmptyState
        icon={BarChart3}
        title="No usage yet"
        description="The usage and limits dashboard arrives in F28."
      />
    </Page>
  );
}
