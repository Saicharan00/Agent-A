'use client';

import type { GoalView } from '@agenta/shared';
import Link from 'next/link';
import { ExportLink } from '@/components/export-link';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { useGoalActions } from '@/hooks/use-goals';
import { canConfirm, goalPercent, goalStatusText } from '@/lib/goals';
import { cn } from '@/lib/utils';

function tone(g: GoalView) {
  if (g.pausedAt) return 'warn' as const;
  if (g.status === 'done') return 'ok' as const;
  return canConfirm(g) ? ('warn' as const) : ('neutral' as const);
}

/** Confirm / pause / resume for one goal. */
export function GoalActions({ goal }: { goal: GoalView }) {
  const { confirm, pause, resume } = useGoalActions();
  if (goal.status === 'done') return null;
  return (
    <div className="flex items-center gap-2">
      {canConfirm(goal) && (
        <Button size="sm" onClick={() => confirm.mutate(goal.id)} disabled={confirm.isPending}>
          Confirm plan
        </Button>
      )}
      {goal.pausedAt ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => resume.mutate(goal.id)}
          disabled={resume.isPending}
        >
          Resume
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={() => pause.mutate(goal.id)} disabled={pause.isPending}>
          Pause
        </Button>
      )}
    </div>
  );
}

/** Progress bar with the task and run budget. */
export function GoalProgress({ goal, className }: { goal: GoalView; className?: string }) {
  const pct = goalPercent(goal);
  return (
    <div className={cn('space-y-1.5', className)}>
      <div
        role="progressbar"
        aria-label={`${goal.title} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground" data-testid="goal-budget">
        {goal.tasksDone}/{goal.tasksTotal} tasks done · tasks {goal.tasksTotal}/{goal.maxTasks} · runs{' '}
        {goal.runsUsed}/{goal.maxRuns}
      </p>
    </div>
  );
}

/** A goal on the home page. */
export function GoalCard({ goal }: { goal: GoalView }) {
  return (
    <li className="space-y-3 rounded-xl border bg-card p-4" data-testid="goal-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          {goal.threadId ? (
            <Link href={`/threads/${goal.threadId}`} className="block truncate font-medium hover:underline">
              {goal.title}
            </Link>
          ) : (
            <span className="block truncate font-medium">{goal.title}</span>
          )}
          <StatusPill tone={tone(goal)}>{goalStatusText(goal)}</StatusPill>
        </div>
        <GoalActions goal={goal} />
      </div>
      <GoalProgress goal={goal} />
    </li>
  );
}

/** Above a goal's conversation: where it stands and the owner's controls. */
export function GoalBar({ goal }: { goal: GoalView }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2" data-testid="goal-bar">
      <StatusPill tone={tone(goal)}>{goalStatusText(goal)}</StatusPill>
      <GoalProgress goal={goal} className="min-w-40 flex-1" />
      <Link href="/tasks" className="text-xs text-primary underline">
        Task board
      </Link>
      <ExportLink path={`/export/goals/${goal.id}`} label="Export report" />
      <GoalActions goal={goal} />
    </div>
  );
}
