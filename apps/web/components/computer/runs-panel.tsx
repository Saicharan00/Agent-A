'use client';

import { ENGINE_LABELS, type BotView, type RunView } from '@agenta/shared';
import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { EmptyState } from '@/components/empty-state';
import { StatusPill } from '@/components/status-pill';
import { Button, buttonVariants } from '@/components/ui/button';
import { useCancelRuns } from '@/hooks/use-thread';
import { relativeTime } from '@/lib/bots';
import { queryKeys } from '@/lib/query-keys';
import { RUN_TRIGGER_LABELS, runStatusView, runsApi } from '@/lib/runs';
import { isActiveRun } from '@/lib/threads';
import { formatDuration } from '@/lib/tools';

/** The bot's recent runs, newest first; kept live by run.updated (lib/live-cache.ts refetches run lists). */
export function RunsPanel({ bot }: { bot: BotView }) {
  const {
    data: runs,
    isPending,
    isError,
  } = useQuery({
    queryKey: queryKeys.botRuns(bot.id),
    queryFn: () => runsApi.forBot(bot.id),
  });
  const { stop, pending } = useCancelRuns();

  if (isPending) return <p className="px-4 text-sm text-muted-foreground">Loading runs…</p>;
  if (isError) return <p className="px-4 text-sm text-destructive">Could not load runs.</p>;
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title="No runs yet"
        description={`${bot.name}'s runs show here once it works on a message, task or schedule.`}
      />
    );
  }
  return (
    <ul aria-label={`${bot.name}'s runs`} className="flex flex-col gap-2">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} onStop={() => stop([run.id])} stopping={pending} />
      ))}
    </ul>
  );
}

function RunRow({ run, onStop, stopping }: { run: RunView; onStop: () => void; stopping: boolean }) {
  const status = runStatusView(run.status);
  const details = [ENGINE_LABELS[run.engine], RUN_TRIGGER_LABELS[run.trigger]];
  if (run.durationMs !== null) details.push(formatDuration(run.durationMs));
  return (
    <li data-testid="run-row" data-run-status={run.status} className="rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        <time
          dateTime={run.createdAt}
          title={new Date(run.createdAt).toLocaleString()}
          className="text-xs text-muted-foreground"
        >
          {relativeTime(run.createdAt)}
        </time>
        <div className="ml-auto flex items-center gap-1">
          {run.threadId && (
            <Link
              href={`/threads/${run.threadId}`}
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
            >
              Open chat
            </Link>
          )}
          {isActiveRun(run) && (
            <Button variant="outline" size="sm" onClick={onStop} disabled={stopping}>
              Stop
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{details.join(' · ')}</p>
      {run.error && <p className="mt-1 line-clamp-2 text-xs text-destructive">{run.error}</p>}
    </li>
  );
}
