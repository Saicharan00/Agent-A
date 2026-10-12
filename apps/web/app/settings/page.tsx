import type { Metadata } from 'next';
import { Page, PageHeader } from '@/components/page-header';
import { EnginesSection } from '@/components/settings/engines-section';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader title="Settings" description="Engines, appearance, guard terms and backups." />
      <EnginesSection />
      <p className="text-sm text-muted-foreground">
        More settings (appearance, guard terms, backups) arrive in F31. Theme can already be changed from the
        top bar or Ctrl+K.
      </p>
    </Page>
  );
}
