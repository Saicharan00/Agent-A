'use client';

import type { BotMcpAccessView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { mcpApi } from '@/lib/mcp';
import { changeGrants } from '@/lib/mcp-form';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

/** Bot page → which MCP gateway servers (and, optionally, which of their tools) this bot may use (F35). */
export function BotMcpAccess({ botId }: { botId: string }) {
  const qc = useQueryClient();
  const servers = useQuery({ queryKey: queryKeys.mcpServers, queryFn: mcpApi.list });
  const access = useQuery({ queryKey: queryKeys.botMcpAccess(botId), queryFn: () => mcpApi.access(botId) });
  const key = queryKeys.botMcpAccess(botId);
  const save = useMutation({
    mutationFn: (next: ReturnType<typeof changeGrants>) => mcpApi.setAccess(botId, next),
    // Optimistic, so the checkboxes follow the click; an in-flight refetch must not overwrite it (as in F29).
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: key });
      qc.setQueryData<BotMcpAccessView[]>(
        key,
        next.map((g) => ({
          botId,
          serverId: g.serverId,
          toolAllowlist: g.tools,
          toolPolicies: g.toolPolicies,
        })),
      );
    },
    onSuccess: (fresh) => {
      qc.setQueryData<BotMcpAccessView[]>(queryKeys.botMcpAccess(botId), fresh);
      void qc.invalidateQueries({ queryKey: queryKeys.mcpServers });
    },
    onError: (err) => {
      toast.error(`Could not save: ${err.message}`);
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const change = (c: Parameters<typeof changeGrants>[1]) => save.mutate(changeGrants(access.data ?? [], c));
  const grants = new Map((access.data ?? []).map((g) => [g.serverId, g]));

  return (
    <section aria-labelledby="bot-mcp-heading" className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 id="bot-mcp-heading" className="text-sm font-semibold">
          MCP servers
        </h2>
        <p className="text-sm text-muted-foreground">
          Tools from servers ticked here appear in this bot&apos;s tools as{' '}
          <code>&lt;server&gt;__&lt;tool&gt;</code> and in its instructions. Add servers in{' '}
          <Link href="/settings/mcp" className="underline underline-offset-4">
            Settings → MCP servers
          </Link>
          .
        </p>
      </div>
      {!servers.data?.length ? (
        <p className="text-sm text-muted-foreground">
          {servers.isLoading || access.isLoading ? 'Loading…' : 'No MCP servers yet.'}
        </p>
      ) : (
        <fieldset className="flex flex-col gap-3" disabled={!access.data}>
          <legend className="sr-only">Servers this bot may use</legend>
          {servers.data.map((s) => {
            const g = grants.get(s.id);
            const allTools = s.tools.map((t) => t.name);
            const visible = s.tools.filter((t) => t.policy !== 'deny');
            return (
              <div key={s.id} className="space-y-1.5" data-testid={`bot-mcp-${s.slug}`}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!g}
                    onChange={(e) => change({ serverId: s.id, on: e.target.checked })}
                  />
                  <span className="font-medium">{s.name}</span>
                  {!s.enabled && <span className="text-xs text-muted-foreground">(disabled)</span>}
                  {s.description && <span className="text-xs text-muted-foreground">{s.description}</span>}
                </label>
                {g && visible.length > 0 && (
                  <div className="ml-6 flex flex-col gap-1">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={g.toolAllowlist === '*'}
                        onChange={(e) => change({ serverId: s.id, everyTool: e.target.checked, allTools })}
                      />
                      Every tool (including ones the server adds later)
                    </label>
                    {g.toolAllowlist !== '*' &&
                      visible.map((t) => (
                        <label key={t.name} className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={(g.toolAllowlist as string[]).includes(t.name)}
                            onChange={(e) =>
                              change({ serverId: s.id, tool: t.name, on: e.target.checked, allTools })
                            }
                          />
                          <code>{t.name}</code>
                          {t.policy === 'approval' && (
                            <span className="text-muted-foreground">(needs approval)</span>
                          )}
                        </label>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
      )}
    </section>
  );
}
