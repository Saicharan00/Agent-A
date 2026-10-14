'use client';

import type { WorkSplitWeek } from '@agenta/shared';
import { useQuery } from '@tanstack/react-query';
import { learnApi } from '@/lib/learn';
import { queryKeys } from '@/lib/query-keys';

const SERIES = [
  { key: 'agent', label: 'Bots', className: 'bg-primary' },
  { key: 'mixed', label: 'Mixed', className: 'bg-primary/45' },
  { key: 'human', label: 'You', className: 'bg-muted-foreground/40' },
] as const;

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
const weekLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Done tasks per week split by who did them, as 100% stacked bars with the 80% bots target line. */
export function WorkSplitPanel() {
  const q = useQuery({ queryKey: queryKeys.workSplit, queryFn: () => learnApi.workSplit(8) });
  if (q.isPending)
    return <div className="h-48 animate-pulse rounded-lg border bg-muted/40" aria-busy="true" />;
  if (q.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {q.error.message}
      </p>
    );
  const { target, weeks } = q.data;
  const total = (w: WorkSplitWeek) => w.agent + w.mixed + w.human;

  return (
    <section aria-label="Work split" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Finished tasks each week by who executed them (set on each task). The goal: bots do {pct(target)} of
        the work, mixed counts half.
      </p>
      <ul className="flex flex-wrap gap-3 text-xs" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-sm ${s.className}`} aria-hidden /> {s.label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="w-4 border-t-2 border-dashed border-foreground/60" aria-hidden /> {pct(target)}{' '}
          target
        </li>
      </ul>
      <figure className="rounded-lg border bg-card p-4" aria-label="Work split chart">
        <div className="relative flex h-48 items-end gap-2">
          <div
            className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-dashed border-foreground/60"
            style={{ bottom: `${target * 100}%` }}
            aria-hidden
          />
          {weeks.map((w) => {
            const n = total(w);
            const tip = `Week of ${weekLabel(w.weekStart)}: bots ${w.agent}, mixed ${w.mixed}, you ${w.human} · bots share ${pct(w.agentShare)}`;
            return (
              <div
                key={w.weekStart}
                title={tip}
                data-testid="work-split-bar"
                className="flex h-full min-w-0 flex-1 flex-col-reverse gap-0.5 rounded-t hover:opacity-90"
              >
                {n === 0 ? (
                  <div className="h-1 rounded bg-muted" />
                ) : (
                  SERIES.map((s) =>
                    w[s.key] ? (
                      <div
                        key={s.key}
                        className={`${s.className} first:rounded-b last:rounded-t-[4px]`}
                        style={{ height: `${(w[s.key] / n) * 100}%` }}
                      />
                    ) : null,
                  )
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex gap-2 text-center text-[11px] text-muted-foreground">
          {weeks.map((w) => (
            <span key={w.weekStart} className="min-w-0 flex-1 truncate">
              {weekLabel(w.weekStart)}
            </span>
          ))}
        </div>
      </figure>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show as table</summary>
        <table className="mt-2 w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Week of</th>
              <th className="font-medium">Bots</th>
              <th className="font-medium">Mixed</th>
              <th className="font-medium">You</th>
              <th className="font-medium">Bots share</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.weekStart} className="border-t">
                <td className="py-1">{weekLabel(w.weekStart)}</td>
                <td>{w.agent}</td>
                <td>{w.mixed}</td>
                <td>{w.human}</td>
                <td>{pct(w.agentShare)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
