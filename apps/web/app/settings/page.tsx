import type { Metadata } from 'next';
import { Page, PageHeader } from '@/components/page-header';
import { ConnectorsSection } from '@/components/settings/connectors-section';
import { DoctorSection } from '@/components/settings/doctor-section';
import { EnginesSection } from '@/components/settings/engines-section';
import { GeneralSection } from '@/components/settings/general-section';
import { GuardSection } from '@/components/settings/guard-section';
import { McpSection } from '@/components/settings/mcp-section';
import { TeamSection } from '@/components/settings/team-section';
import { UsageSettingsForm } from '@/components/usage/usage-view';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <Page>
      <PageHeader
        title="Settings"
        description="General, health check, engines, concurrency, team, guard terms, connectors and MCP servers."
      />
      <GeneralSection />
      <DoctorSection />
      <EnginesSection />
      <UsageSettingsForm title="Concurrency & run budgets" />
      <TeamSection />
      <GuardSection />
      <ConnectorsSection />
      <McpSection />
    </Page>
  );
}
