'use client';

import type { EngineAuthStatus } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { ENGINE_LABELS, engineView } from '@/lib/engines';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

export const ENGINES_QUERY_KEY = queryKeys.engineAuth;

function EngineCard({ status }: { status: EngineAuthStatus }) {
  const view = engineView(status);
  const name = ENGINE_LABELS[status.engine];
  return (
    <article
      className="flex flex-col gap-3 rounded-lg border p-4"
      data-testid={`engine-${status.engine}`}
      aria-label={`${name} engine`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{name}</h3>
        <StatusPill tone={view.tone} data-testid={`engine-${status.engine}-state`}>
          {view.state}
        </StatusPill>
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Auth mode</dt>
        <dd data-testid={`engine-${status.engine}-mode`}>{view.mode}</dd>
        {status.perBotLogins.length > 0 && (
          <>
            <dt className="text-muted-foreground">Own logins</dt>
            <dd>{status.perBotLogins.join(', ')}</dd>
          </>
        )}
        <dt className="text-muted-foreground">CLI check</dt>
        <dd className="break-words">{view.cli ?? status.cli.reason ?? 'Not checked'}</dd>
      </dl>
      <p className="text-sm text-muted-foreground">{status.detail}</p>
      {status.fix.length > 0 && (
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="mb-1 font-medium">{status.state === 'configured' ? 'Options' : 'How to fix'}</p>
          <ol className="list-decimal space-y-1 pl-5">
            {status.fix.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}

/** Settings → Engines: per-engine auth status with fix instructions (F06). */
export function EnginesSection() {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery({
    queryKey: ENGINES_QUERY_KEY,
    queryFn: () => api.engines(),
  });
  const recheck = useMutation({
    mutationFn: () => api.engines({ verify: true }),
    onSuccess: (fresh) => queryClient.setQueryData(ENGINES_QUERY_KEY, fresh),
    onError: (err) => toast.error(`Re-check failed: ${err.message}`),
  });

  return (
    <section aria-labelledby="engines-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id="engines-heading" className="text-lg font-semibold">
            Engines
          </h2>
          <p className="text-sm text-muted-foreground">
            How bots sign in to Claude Code and Codex with your subscriptions. Secrets stay in .env.local and
            data/secrets and are never shown here.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
          <RefreshCw className={recheck.isPending ? 'animate-spin' : undefined} />
          Re-check
        </Button>
      </div>
      {isPending && <p className="text-sm text-muted-foreground">Checking…</p>}
      {error && <p className="text-sm text-destructive">Could not load engine status: {error.message}</p>}
      {data && (
        <div className="grid gap-4 md:grid-cols-2">
          {data.engines.map((s) => (
            <EngineCard key={s.engine} status={s} />
          ))}
        </div>
      )}
    </section>
  );
}
