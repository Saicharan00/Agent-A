'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { mcpApi } from '@/lib/mcp';
import { queryKeys } from '@/lib/query-keys';

/** Settings → link to the MCP servers page (F35), with a one-line summary. */
export function McpSection() {
  const { data } = useQuery({ queryKey: queryKeys.mcpServers, queryFn: mcpApi.list });
  const enabled = data?.filter((s) => s.enabled).length ?? 0;
  return (
    <section
      aria-labelledby="mcp-heading"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
    >
      <div className="space-y-1">
        <h2 id="mcp-heading" className="text-lg font-semibold">
          MCP servers & web research
        </h2>
        <p className="text-sm text-muted-foreground">
          {data ? `${data.length} server${data.length === 1 ? '' : 's'}, ${enabled} enabled.` : 'Loading…'}{' '}
          Add any MCP server, choose which bots may use it, and set how bots reach the web.
        </p>
      </div>
      <Link href="/settings/mcp" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        Manage MCP servers
      </Link>
    </section>
  );
}
