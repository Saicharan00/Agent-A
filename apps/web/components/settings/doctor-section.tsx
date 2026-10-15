'use client';

import type { DoctorCheck } from '@agenta/shared';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/lib/query-keys';
import { DOCTOR_LABEL, DOCTOR_TONE, systemApi } from '@/lib/system';
import { ImageBuild } from './image-build';

export function useDoctor() {
  return useQuery({ queryKey: queryKeys.doctor, queryFn: systemApi.doctor });
}

export function DoctorCheckRow({ check }: { check: DoctorCheck }) {
  return (
    <li className="space-y-2 py-3" data-testid={`doctor-${check.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{check.label}</span>
        <StatusPill tone={DOCTOR_TONE[check.status]}>{DOCTOR_LABEL[check.status]}</StatusPill>
      </div>
      <p className="text-sm text-muted-foreground">{check.summary}</p>
      {check.fix.length > 0 && (
        <ol className="list-decimal space-y-1 rounded-md bg-muted/50 p-3 pl-8 text-sm">
          {check.fix.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {check.id === 'image' && check.status !== 'ok' && !check.summary.startsWith('not checked') && (
        <ImageBuild />
      )}
    </li>
  );
}

/** Settings → Health check: the same report as `pnpm doctor` (F31). */
export function DoctorSection() {
  const { data, error, isFetching, refetch } = useDoctor();
  return (
    <section aria-labelledby="doctor-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <h2 id="doctor-heading" className="text-lg font-semibold">
            Health check
          </h2>
          <p className="text-sm text-muted-foreground">
            Docker, the bot image, disk, ports, database and engine sign-in. Same as `pnpm doctor` in the
            sandbox.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
          Run again
        </Button>
      </div>
      {!data && !error && <p className="text-sm text-muted-foreground">Checking…</p>}
      {error && <p className="text-sm text-destructive">Could not run the health check: {error.message}</p>}
      {data && !data.insideSandbox && (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm font-medium text-destructive"
        >
          Agent A is not running inside the Docker Sandbox VM. Stop it and run it only inside the agent-a
          sandbox.
        </p>
      )}
      {data && (
        <ul className="divide-y rounded-lg border px-4" aria-label="Health checks">
          {data.checks.map((c) => (
            <DoctorCheckRow key={c.id} check={c} />
          ))}
        </ul>
      )}
    </section>
  );
}
