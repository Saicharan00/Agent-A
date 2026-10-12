import { Settings } from 'lucide-react';
import type { Metadata } from 'next';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader title="Settings" description="Engines, appearance, guard terms and backups." />
      <EmptyState
        icon={Settings}
        title="Settings arrive in F31"
        description="Theme can already be changed from the top bar or Ctrl+K."
      />
    </Page>
  );
}
