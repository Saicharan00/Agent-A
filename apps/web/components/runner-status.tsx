'use client';

import { useEffect, useState } from 'react';
import { fetchRunnerStatus, type RunnerStatus } from '@/lib/runner';
import { cn } from '@/lib/utils';

export function RunnerStatusBadge() {
  const [status, setStatus] = useState<RunnerStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchRunnerStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = status === null ? 'checking…' : status.state === 'ok' ? 'ok' : `down (${status.reason})`;
  return (
    <div
      data-testid="runner-status"
      className={cn(
        'w-fit rounded-md border px-3 py-1.5 text-sm',
        status?.state === 'ok' && 'border-green-600/40 text-green-700',
        status?.state === 'down' && 'border-destructive/40 text-destructive',
      )}
    >
      Runner: {label}
    </div>
  );
}
