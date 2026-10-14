import type { Repos, Run } from '@agenta/db';
import {
  ENGINES,
  ENGINE_BUDGETS_SETTING,
  type Engine,
  type UsageReport,
  type UsageSettings,
  type UsageTotals,
  budgetState,
} from '@agenta/shared';
import { MAX_CONCURRENT_SETTING, type RunService, limitResetOf } from '../runs/service';

// Usage & limits dashboard (F28): runs, run time, tokens and API-cost equivalents over the last N days, read straight
// from the runs table; plus the budget settings the run scheduler enforces.

const DAY_MS = 24 * 3_600_000;

const emptyTotals = (): UsageTotals => ({
  runs: 0,
  durationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsdEquivalent: 0,
});

function add(t: UsageTotals, run: Run): void {
  t.runs++;
  t.durationMs += run.durationMs ?? 0;
  t.inputTokens += run.usage?.inputTokens ?? 0;
  t.outputTokens += run.usage?.outputTokens ?? 0;
  t.costUsdEquivalent += run.usage?.costUsdEquivalent ?? 0;
}

/** YYYY-MM-DD of `d` in `tz` ('en-CA' formats dates that way). Throws RangeError for an unknown zone. */
const dayFormatter = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

/** The last `days` calendar days ending today in `tz`, oldest first. Calendar math, so DST never skips a day. */
export function dayKeys(now: Date, days: number, tz: string): string[] {
  const today = Date.parse(`${dayFormatter(tz).format(now)}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) =>
    new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

export function buildUsageReport(
  repos: Repos,
  runs: RunService,
  q: { days: number; tz?: string | undefined },
  now: Date = new Date(),
): UsageReport {
  // Some browsers report zones Node does not know (headless Chromium says "Etc/Unknown"): fall back to UTC.
  let tz = q.tz ?? 'UTC';
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = dayFormatter(tz);
  } catch {
    tz = 'UTC';
    fmt = dayFormatter(tz);
  }
  const keys = dayKeys(now, q.days, tz);
  const perDay = new Map(keys.map((date) => [date, {} as Partial<Record<Engine, number>>]));
  const totals = emptyTotals();
  const perEngine = new Map<Engine, UsageTotals>();
  const perBot = new Map<string, UsageTotals>();
  const limitHits: UsageReport['limitHits'] = [];
  const botName = (id: string) => repos.bots.get(id)?.name ?? 'Deleted bot';

  // One extra day back covers zones ahead of UTC; runs outside the day keys are dropped below.
  for (const run of repos.runs.listCreatedSince(
    new Date(now.getTime() - (q.days + 1) * DAY_MS).toISOString(),
  )) {
    const day = perDay.get(fmt.format(new Date(run.createdAt)));
    if (!day || run.status === 'queued') continue;
    day[run.engine] = (day[run.engine] ?? 0) + 1;
    add(totals, run);
    add(perEngine.get(run.engine) ?? perEngine.set(run.engine, emptyTotals()).get(run.engine)!, run);
    add(perBot.get(run.botId) ?? perBot.set(run.botId, emptyTotals()).get(run.botId)!, run);
    if (run.status === 'limited') {
      limitHits.unshift({
        runId: run.id,
        botId: run.botId,
        botName: botName(run.botId),
        engine: run.engine,
        at: run.finishedAt ?? run.createdAt,
        resetsAt: limitResetOf(run.error),
      });
    }
  }

  const budgets = runs.engineBudgets();
  const nowIso = now.toISOString();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  // Claude and Codex always show; the mock engine only once it has runs or a budget.
  const engines = ENGINES.filter((e) => e !== 'mock' || perEngine.has(e) || budgets[e]);

  return {
    days: q.days,
    tz,
    totals,
    perDay: keys.map((date) => ({ date, runs: perDay.get(date)! })),
    perEngine: engines.map((engine) => {
      const last24h = repos.runs.countStartedSince(engine, dayAgo);
      const budget = budgets[engine] ?? null;
      const limitedUntil = repos.engineState.get(engine)?.limitedUntil ?? null;
      return {
        engine,
        ...(perEngine.get(engine) ?? emptyTotals()),
        last24h,
        budget,
        budgetState: budgetState(last24h, budget?.dailyRuns),
        limitedUntil: limitedUntil && limitedUntil > nowIso ? limitedUntil : null,
      };
    }),
    perBot: [...perBot]
      .map(([botId, t]) => ({ botId, name: botName(botId), ...t }))
      .sort((a, b) => b.runs - a.runs),
    limitHits,
    running: repos.runs.countByStatus('running'),
    maxConcurrentRuns: runs.maxConcurrent(),
    queued: repos.runs.countByStatus('queued'),
    goals: repos.goals
      .list()
      .filter((g) => g.status !== 'done')
      .map((g) => {
        const runsUsed = repos.goals.countRuns(g.id);
        return {
          id: g.id,
          title: g.title,
          status: g.status,
          runsUsed,
          maxRuns: g.maxRuns,
          budgetState: budgetState(runsUsed, g.maxRuns),
        };
      }),
  };
}

export function readUsageSettings(runs: RunService): UsageSettings {
  return { maxConcurrentRuns: runs.maxConcurrent(), budgets: runs.engineBudgets() };
}

/** Saves the settings and wakes the scheduler, since a higher cap or budget can start queued runs now. */
export function writeUsageSettings(repos: Repos, runs: RunService, s: UsageSettings): UsageSettings {
  repos.settings.set(MAX_CONCURRENT_SETTING, s.maxConcurrentRuns);
  repos.settings.set(ENGINE_BUDGETS_SETTING, s.budgets);
  runs.schedule();
  return readUsageSettings(runs);
}
