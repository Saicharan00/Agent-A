import type { Metadata } from 'next';
import { Page, PageHeader } from '@/components/page-header';
import { ConnectorsSection } from '@/components/settings/connectors-section';
import { EnginesSection } from '@/components/settings/engines-section';
import { GuardSection } from '@/components/settings/guard-section';
import { TeamSection } from '@/components/settings/team-section';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Engines, team, guard terms, connectors, appearance and backups."
      />
      <EnginesSection />
      <TeamSection />
      <GuardSection />
      <ConnectorsSection />
      <p className="text-sm text-muted-foreground">
        More settings (appearance, backups) arrive in F31. Theme can already be changed from the top bar or
        Ctrl+K.
      </p>
    </Page>
  );
}
