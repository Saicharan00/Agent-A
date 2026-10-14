'use client';

import type { ConnectorPatch, ConnectorView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StatusPill } from '@/components/status-pill';
import { useBots } from '@/hooks/use-bots';
import { connectorsApi } from '@/lib/connectors';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

function GithubCard({ connector }: { connector: ConnectorView }) {
  const qc = useQueryClient();
  const bots = useBots();
  const put = (fn: (c: ConnectorView) => ConnectorView) =>
    qc.setQueryData<ConnectorView[]>(queryKeys.connectors, (old) =>
      old?.map((c) => (c.id === connector.id ? fn(c) : c)),
    );
  const update = useMutation({
    mutationFn: (patch: ConnectorPatch) => connectorsApi.update(connector.id, patch),
    // Optimistic, so the checkboxes follow the click; an in-flight refetch must not overwrite it with old data.
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: queryKeys.connectors });
      put((c) => ({ ...c, ...patch }));
    },
    onSuccess: (fresh) => put(() => fresh),
    onError: (err) => {
      toast.error(`Could not save: ${err.message}`);
      void qc.invalidateQueries({ queryKey: queryKeys.connectors });
    },
  });
  const save = (patch: ConnectorPatch) => update.mutate(patch);
  const allowed = new Set(connector.botIds);
  const toggleBot = (botId: string, on: boolean) => {
    const next = new Set(allowed);
    if (on) next.add(botId);
    else next.delete(botId);
    save({ botIds: [...next] });
  };

  return (
    <article
      className="flex flex-col gap-3 rounded-lg border p-4"
      data-testid="connector-github"
      aria-label="GitHub connector"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">GitHub</h3>
        <StatusPill tone={connector.tokenPresent ? 'ok' : 'warn'} data-testid="connector-github-token">
          {connector.tokenPresent ? 'token set' : 'token missing'}
        </StatusPill>
      </div>
      <p className="text-sm text-muted-foreground">
        Enabled bots get your token as <code>GH_TOKEN</code> in their runs and terminals, so <code>gh</code>{' '}
        and <code>git</code> work. They ask for approval before pushing, opening pull requests or commenting.
      </p>
      {!connector.tokenPresent && (
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="mb-1 font-medium">How to set up</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              On github.com: Settings → Developer settings → Fine-grained tokens → Generate new token, with
              access to only the repositories the bots may use.
            </li>
            <li>
              Add it to .env.local as <code>{connector.tokenEnv}=…</code> (never paste it into chat). No
              restart needed: reload this page.
            </li>
          </ol>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={connector.enabled}
          disabled={update.isPending}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        Enable GitHub
      </label>
      <fieldset className="flex flex-col gap-1" disabled={update.isPending}>
        <legend className="mb-1 text-sm font-medium">Bots that may use GitHub</legend>
        {bots.data?.length ? (
          bots.data.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={allowed.has(b.id)}
                onChange={(e) => toggleBot(b.id, e.target.checked)}
              />
              {b.name}
            </label>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">{bots.isLoading ? 'Loading…' : 'No bots yet.'}</p>
        )}
      </fieldset>
    </article>
  );
}

/** Settings → Connectors (F29): GitHub token status, on/off and which bots may use it. */
export function ConnectorsSection() {
  const { data, error } = useQuery({ queryKey: queryKeys.connectors, queryFn: connectorsApi.list });
  const github = data?.find((c) => c.type === 'github');
  return (
    <section aria-labelledby="connectors-heading" className="flex flex-col gap-4">
      <div className="space-y-1">
        <h2 id="connectors-heading" className="text-lg font-semibold">
          Connectors
        </h2>
        <p className="text-sm text-muted-foreground">
          Outside services chosen bots can work with. Tokens stay in .env.local and are never shown here.
        </p>
      </div>
      {github ? (
        <GithubCard connector={github} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {error ? `Could not load: ${error.message}` : 'Loading…'}
        </p>
      )}
    </section>
  );
}
