import type { Metadata } from 'next';
import Link from 'next/link';
import { Page, PageHeader } from '@/components/page-header';
import { McpServersView } from '@/components/settings/mcp-servers';

export const metadata: Metadata = { title: 'MCP servers' };

export default function McpServersPage() {
  return (
    <Page>
      <PageHeader
        title="MCP servers & web research"
        description="Plug in any MCP server and give its tools to chosen bots, safely and observably."
        actions={
          <Link href="/settings" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Back to Settings
          </Link>
        }
      />
      <McpServersView />
    </Page>
  );
}
