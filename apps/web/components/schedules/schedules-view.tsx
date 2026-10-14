'use client';

import type { ScheduleOutcome, ScheduleView } from '@agenta/shared';
import { CalendarClock, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { EmptyState } from '@/components/empty-state';
import { type PillTone, StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { useBots } from '@/hooks/use-bots';
import { useScheduleActions, useScheduleHistory, useSchedules } from '@/hooks/use-schedules';
import { describeCron } from '@/lib/schedules';
import { toast } from '@/lib/toast';
import { ScheduleForm } from './schedule-form';

const OUTCOME_TONE: Record<ScheduleOutcome, PillTone> = { started: 'ok', skipped: 'warn', failed: 'error' };
const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** The /schedules page: the owner's schedules, a form to add or edit one, Run now and each schedule's history. */
export function SchedulesView() {
  const schedules = useSchedules();
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  return (
    <div className="space-y-4">
      {editing === 'new' ? (
        <ScheduleForm onDone={() => setEditing(null)} />
      ) : (
        <Button onClick={() => setEditing('new')}>
          <Plus /> New schedule
        </Button>
      )}
      {schedules.data?.length === 0 && editing !== 'new' && (
        <EmptyState
          icon={CalendarClock}
          title="No schedules"
          description="Have a bot run a prompt on a timer: a daily plan, a weekly review, a check that something still works."
        />
      )}
      <ul className="space-y-3" aria-label="Schedules">
        {schedules.data?.map((s) =>
          editing === s.id ? (
            <li key={s.id}>
              <ScheduleForm schedule={s} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <ScheduleCard key={s.id} schedule={s} onEdit={() => setEditing(s.id)} />
          ),
        )}
      </ul>
    </div>
  );
}

function ScheduleCard({ schedule: s, onEdit }: { schedule: ScheduleView; onEdit: () => void }) {
  const router = useRouter();
  const bots = useBots('include');
  const bot = bots.data?.find((b) => b.id === s.botId);
  const { update, remove, runNow } = useScheduleActions();
  const [showHistory, setShowHistory] = useState(false);

  const run = () =>
    runNow.mutate(s.id, {
      onSuccess: (r) => {
        if (r.outcome === 'started' && r.threadId) router.push(`/threads/${r.threadId}`);
        else toast.error(r.reason ?? 'The schedule did not start');
      },
    });
  const toggle = () =>
    update.mutate(
      { id: s.id, enabled: !s.enabled },
      { onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not update') },
    );

  return (
    <li className="space-y-2 rounded-xl border bg-card p-4" aria-label={`Schedule ${s.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        {bot && <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} size="sm" />}
        <h3 className="font-semibold">{s.name}</h3>
        <span className="text-sm text-muted-foreground">{bot?.name ?? '…'}</span>
        <StatusPill tone={s.enabled ? 'ok' : 'neutral'} className="ml-auto">
          {s.enabled ? 'Enabled' : 'Off'}
        </StatusPill>
      </div>
      <p className="text-sm">
        {describeCron(s.cron)} <span className="text-muted-foreground">({s.timezone})</span>
        {s.catchUp && <span className="text-muted-foreground"> · catches up if missed</span>}
      </p>
      <p className="line-clamp-2 text-sm text-muted-foreground">{s.prompt}</p>
      <p className="text-xs text-muted-foreground">
        Next run: {s.enabled ? local(s.nextRunAt) : 'off'} · Last run: {local(s.lastRunAt)} · Posts in{' '}
        {s.threadId ? (
          <Link href={`/threads/${s.threadId}`} className="underline">
            its thread
          </Link>
        ) : (
          'a new thread each run'
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={run} disabled={runNow.isPending}>
          Run now
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="outline" onClick={toggle} disabled={update.isPending}>
          {s.enabled ? 'Disable' : 'Enable'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowHistory((v) => !v)}
          aria-expanded={showHistory}
        >
          History
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-destructive"
          onClick={() => window.confirm(`Delete the schedule "${s.name}"?`) && remove.mutate(s.id)}
        >
          Delete
        </Button>
      </div>
      {showHistory && <ScheduleHistory id={s.id} />}
    </li>
  );
}

function ScheduleHistory({ id }: { id: string }) {
  const history = useScheduleHistory(id, true);
  if (!history.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (history.data.length === 0) return <p className="text-sm text-muted-foreground">Not run yet.</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm" aria-label="Schedule history">
      {history.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
          <StatusPill tone={OUTCOME_TONE[r.outcome]}>{r.outcome}</StatusPill>
          <span>{local(r.createdAt)}</span>
          {r.manual && <span className="text-muted-foreground">Run now</span>}
          {r.runStatus && <span className="text-muted-foreground">run {r.runStatus}</span>}
          {r.reason && <span className="text-muted-foreground">{r.reason}</span>}
          {r.threadId && (
            <Link href={`/threads/${r.threadId}`} className="ml-auto underline">
              Open thread
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
