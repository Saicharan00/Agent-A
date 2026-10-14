'use client';

import {
  ENGINE_LABELS,
  type Engine,
  type EngineBudgets,
  USER_ENGINES,
  type UsageReport,
  type UsageSettings,
} from '@agenta/shared';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/form';
import { useUsage, useUsageActions, useUsageSettings } from '@/hooks/use-usage';
import { BUDGET_TONE, budgetText, formatDuration, formatTokens, formatUsd } from '@/lib/usage';
import { cn } from '@/lib/utils';

const ENGINE_BAR: Record<Engine, string> = {
  claude: 'bg-primary',
  codex: 'bg-success',
  mock: 'bg-muted-foreground/50',
};
const local = (iso: string) => new Date(iso).toLocaleString();
const RANGES = [7, 14, 30, 90];

/** The /usage page: how hard the subscriptions are used, limit hits, budgets and the queue settings. */
export function UsageView() {
  const [days, setDays] = useState(14);
  const usage = useUsage(days);
  const r = usage.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="usage-range">Period</label>
        <Select
          id="usage-range"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="w-36"
        >
          {RANGES.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </Select>
      </div>
      {usage.isError && (
        <p className="text-sm text-destructive">Could not load usage: {usage.error.message}</p>
      )}
      {r && (
        <>
          <BudgetWarnings report={r} />
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Tile label="Runs" value={String(r.totals.runs)} />
            <Tile label="Run time" value={formatDuration(r.totals.durationMs)} />
            <Tile
              label="Tokens in / out"
              value={`${formatTokens(r.totals.inputTokens)} / ${formatTokens(r.totals.outputTokens)}`}
            />
            <Tile
              label="API-cost equivalent"
              value={formatUsd(r.totals.costUsdEquivalent)}
              hint="Equivalent, not billed"
            />
            <Tile label="Running now" value={`${r.running} of ${r.maxConcurrentRuns}`} />
            <Tile label="Queued" value={String(r.queued)} />
          </section>
          <RunsPerDay report={r} />
          <Section title="Engines">
            <Table
              head={[
                'Engine',
                'Runs',
                'Run time',
                'Tokens in / out',
                'Cost equivalent',
                'Last 24 h',
                'Status',
              ]}
            >
              {r.perEngine.map((e) => (
                <tr key={e.engine}>
                  <td>{ENGINE_LABELS[e.engine]}</td>
                  <td>{e.runs}</td>
                  <td>{formatDuration(e.durationMs)}</td>
                  <td>
                    {formatTokens(e.inputTokens)} / {formatTokens(e.outputTokens)}
                  </td>
                  <td>{formatUsd(e.costUsdEquivalent)}</td>
                  <td>
                    <StatusPill tone={BUDGET_TONE[e.budgetState]} data-testid={`budget-${e.engine}`}>
                      {budgetText(e.last24h, e.budget?.dailyRuns, e.budgetState)}
                      {e.budget?.hardStop && e.budgetState === 'over' ? ' · new runs wait' : ''}
                    </StatusPill>
                  </td>
                  <td>
                    {e.limitedUntil ? (
                      <StatusPill tone="error">Limited until {local(e.limitedUntil)}</StatusPill>
                    ) : (
                      <StatusPill tone="ok">ok</StatusPill>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          </Section>
          <Section title="Bots">
            {r.perBot.length === 0 ? (
              <Empty>No runs in this period.</Empty>
            ) : (
              <Table head={['Bot', 'Runs', 'Run time', 'Tokens in / out', 'Cost equivalent']}>
                {r.perBot.map((b) => (
                  <tr key={b.botId}>
                    <td>{b.name}</td>
                    <td>{b.runs}</td>
                    <td>{formatDuration(b.durationMs)}</td>
                    <td>
                      {formatTokens(b.inputTokens)} / {formatTokens(b.outputTokens)}
                    </td>
                    <td>{formatUsd(b.costUsdEquivalent)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <Section title="Limit hits">
            {r.limitHits.length === 0 ? (
              <Empty>No usage limit was hit in this period.</Empty>
            ) : (
              <Table head={['When', 'Engine', 'Bot', 'Resets at']}>
                {r.limitHits.map((l) => (
                  <tr key={l.runId}>
                    <td>{local(l.at)}</td>
                    <td>{ENGINE_LABELS[l.engine]}</td>
                    <td>{l.botName}</td>
                    <td>{l.resetsAt ? local(l.resetsAt) : 'unknown'}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
          <GoalBudgets goals={r.goals} />
        </>
      )}
      <SettingsForm />
    </div>
  );
}

function BudgetWarnings({ report: r }: { report: UsageReport }) {
  const lines = [
    ...r.perEngine
      .filter((e) => e.budgetState === 'warn' || e.budgetState === 'over')
      .map(
        (e) =>
          `${ENGINE_LABELS[e.engine]}: ${budgetText(e.last24h, e.budget?.dailyRuns, e.budgetState)} in the last 24 hours` +
          (e.budgetState === 'over' && e.budget?.hardStop ? '. New runs wait in the queue.' : '.'),
      ),
    ...r.goals
      .filter((g) => g.budgetState === 'warn' || g.budgetState === 'over')
      .map((g) => `Goal "${g.title}": ${budgetText(g.runsUsed, g.maxRuns, g.budgetState)}.`),
  ];
  if (!lines.length) return null;
  return (
    <div role="alert" className="space-y-1 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
      <p className="font-medium">Budget warning</p>
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

/** Stacked bars of runs per day and engine; plain CSS, no chart library. */
function RunsPerDay({ report: r }: { report: UsageReport }) {
  const totals = r.perDay.map((d) => Object.values(d.runs).reduce((a, b) => a + b, 0));
  const peak = Math.max(1, ...totals);
  const engines = r.perEngine.map((e) => e.engine);
  return (
    <Section title="Runs per day">
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {engines.map((e) => (
          <span key={e} className="flex items-center gap-1">
            <span aria-hidden className={cn('size-2 rounded-sm', ENGINE_BAR[e])} />
            {ENGINE_LABELS[e]}
          </span>
        ))}
        <span className="ml-auto">peak {peak}</span>
      </div>
      <ol aria-label="Runs per day" className="flex h-36 items-end gap-1 border-b">
        {r.perDay.map((d, i) => (
          <li
            key={d.date}
            className="flex h-full min-w-0 flex-1 flex-col-reverse"
            title={`${d.date}: ${totals[i]} runs`}
            aria-label={`${d.date}: ${totals[i]} runs`}
          >
            {engines.map((e) =>
              d.runs[e] ? (
                <span
                  key={e}
                  className={cn('w-full first:rounded-b-none last:rounded-t-sm', ENGINE_BAR[e])}
                  style={{ height: `${((d.runs[e] ?? 0) / peak) * 100}%` }}
                />
              ) : null,
            )}
          </li>
        ))}
      </ol>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{r.perDay[0]?.date}</span>
        <span>{r.perDay.at(-1)?.date}</span>
      </div>
    </Section>
  );
}

function GoalBudgets({ goals }: { goals: UsageReport['goals'] }) {
  return (
    <Section title="Goal budgets">
      {goals.length === 0 ? (
        <Empty>No goal is in progress.</Empty>
      ) : (
        <ul className="space-y-2">
          {goals.map((g) => (
            <GoalBudgetRow key={g.id} goal={g} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function GoalBudgetRow({ goal: g }: { goal: UsageReport['goals'][number] }) {
  const { setGoalBudget } = useUsageActions();
  const [maxRuns, setMaxRuns] = useState(String(g.maxRuns));
  const id = `goal-budget-${g.id}`;
  return (
    <li className="flex flex-wrap items-center gap-3 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">{g.title}</span>
      <StatusPill tone={BUDGET_TONE[g.budgetState]}>
        {budgetText(g.runsUsed, g.maxRuns, g.budgetState)}
      </StatusPill>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setGoalBudget.mutate({ id: g.id, maxRuns: Number(maxRuns) });
        }}
      >
        <label htmlFor={id} className="sr-only">
          Run budget for {g.title}
        </label>
        <Input
          id={id}
          type="number"
          min={1}
          max={1000}
          value={maxRuns}
          onChange={(e) => setMaxRuns(e.target.value)}
          className="w-24"
        />
        <Button type="submit" variant="outline" size="sm" disabled={setGoalBudget.isPending}>
          Set
        </Button>
      </form>
    </li>
  );
}

type BudgetDraft = Record<string, { dailyRuns: string; hardStop: boolean }>;

const toDraft = (b: EngineBudgets): BudgetDraft =>
  Object.fromEntries(
    USER_ENGINES.map((e) => [
      e,
      { dailyRuns: b[e]?.dailyRuns ? String(b[e].dailyRuns) : '', hardStop: !!b[e]?.hardStop },
    ]),
  );

function SettingsForm() {
  const settings = useUsageSettings();
  const { saveSettings } = useUsageActions();
  const [maxConcurrent, setMaxConcurrent] = useState('2');
  const [draft, setDraft] = useState<BudgetDraft>(() => toDraft({}));

  useEffect(() => {
    if (!settings.data) return;
    setMaxConcurrent(String(settings.data.maxConcurrentRuns));
    setDraft(toDraft(settings.data.budgets));
  }, [settings.data]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const budgets: UsageSettings['budgets'] = { ...settings.data?.budgets };
    for (const engine of USER_ENGINES) {
      const n = Number.parseInt(draft[engine]!.dailyRuns, 10);
      budgets[engine] = {
        dailyRuns: Number.isFinite(n) && n > 0 ? n : null,
        hardStop: draft[engine]!.hardStop,
      };
    }
    saveSettings.mutate({ maxConcurrentRuns: Number(maxConcurrent), budgets });
  }

  return (
    <form onSubmit={submit} aria-label="Usage settings" className="space-y-3 rounded-xl border bg-card p-4">
      <h2 className="text-base font-semibold">Settings</h2>
      <Field
        label="Max concurrent runs"
        htmlFor="usage-max-concurrent"
        hint="Runs across all bots at once (1–8). More runs at once use your subscriptions faster."
        className="max-w-xs"
      >
        <Input
          id="usage-max-concurrent"
          type="number"
          min={1}
          max={8}
          value={maxConcurrent}
          onChange={(e) => setMaxConcurrent(e.target.value)}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {USER_ENGINES.map((engine) => (
          <fieldset key={engine} className="space-y-2 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{ENGINE_LABELS[engine]}</legend>
            <Field
              label="Daily run budget"
              htmlFor={`usage-budget-${engine}`}
              hint="Runs started in the last 24 hours. Warns at 80 %. Empty for no budget."
            >
              <Input
                id={`usage-budget-${engine}`}
                type="number"
                min={1}
                value={draft[engine]!.dailyRuns}
                onChange={(e) =>
                  setDraft({ ...draft, [engine]: { ...draft[engine]!, dailyRuns: e.target.value } })
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft[engine]!.hardStop}
                onChange={(e) =>
                  setDraft({ ...draft, [engine]: { ...draft[engine]!, hardStop: e.target.checked } })
                }
              />
              Hard stop: new runs wait in the queue once the budget is used up
            </label>
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={saveSettings.isPending}>
          {saveSettings.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </form>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_tr]:border-b last:[&_tr]:border-0">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">{children}</tbody>
      </table>
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);
