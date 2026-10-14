import type { Metadata } from 'next';
import { Page, PageHeader } from '@/components/page-header';
import { UsageView } from '@/components/usage/usage-view';

export const metadata: Metadata = { title: 'Usage' };

export default function UsagePage() {
  return (
    <Page>
      <PageHeader title="Usage" description="Runs, run time, tokens, limit hits and budgets per engine." />
      <UsageView />
    </Page>
  );
}
