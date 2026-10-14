// Usage & limits dashboard (F28): the /api/usage report, the budget settings and the budget threshold rule.
import { z } from 'zod';
import { ENGINES } from './enums';

/** A soft budget warns once this share of it is used. */
export const BUDGET_WARN_RATIO = 0.8;
/** Settings key of the per-engine daily run budgets. */
export const ENGINE_BUDGETS_SETTING = 'engineBudgets';

export const BUDGET_STATES = ['none', 'ok', 'warn', 'over'] as const;
export type BudgetState = (typeof BUDGET_STATES)[number];

/** `none` without a budget, `warn` from 80 % of it, `over` once it is used up. */
export function budgetState(used: number, budget: number | null | undefined): BudgetState {
  if (!budget) return 'none';
  if (used >= budget) return 'over';
  return used >= budget * BUDGET_WARN_RATIO ? 'warn' : 'ok';
}

export const engineBudgetSchema = z.object({
  /** Runs started in the last 24 hours. */
  dailyRuns: z.number().int().min(1).max(10_000).nullable(),
  /** Hold new runs of this engine in the queue once the budget is used up. */
  hardStop: z.boolean(),
});
export type EngineBudget = z.infer<typeof engineBudgetSchema>;

export const engineBudgetsSchema = z.partialRecord(z.enum(ENGINES), engineBudgetSchema);
export type EngineBudgets = z.infer<typeof engineBudgetsSchema>;

/** GET/PUT /api/usage/settings */
export const usageSettingsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(8),
  budgets: engineBudgetsSchema,
});
export type UsageSettings = z.infer<typeof usageSettingsSchema>;

/** GET /api/usage?days=&tz= — `tz` is the IANA zone the per-day buckets use (default UTC). */
export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
  tz: z.string().max(64).optional(),
});
export type UsageQuery = z.input<typeof usageQuerySchema>;

const totalsSchema = z.object({
  runs: z.number().int(),
  durationMs: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** What the tokens would cost on the API; subscriptions are not billed per token. */
  costUsdEquivalent: z.number(),
});
export type UsageTotals = z.infer<typeof totalsSchema>;

export const usageReportSchema = z.object({
  days: z.number().int(),
  tz: z.string(),
  totals: totalsSchema,
  /** Oldest day first; runs per engine that day. */
  perDay: z.array(z.object({ date: z.string(), runs: z.partialRecord(z.enum(ENGINES), z.number().int()) })),
  perEngine: z.array(
    totalsSchema.extend({
      engine: z.enum(ENGINES),
      /** Runs started in the last 24 hours (what the budget counts). */
      last24h: z.number().int(),
      budget: engineBudgetSchema.nullable(),
      budgetState: z.enum(BUDGET_STATES),
      limitedUntil: z.string().nullable(),
    }),
  ),
  perBot: z.array(totalsSchema.extend({ botId: z.string(), name: z.string() })),
  /** Newest first. */
  limitHits: z.array(
    z.object({
      runId: z.string(),
      botId: z.string(),
      botName: z.string(),
      engine: z.enum(ENGINES),
      at: z.string(),
      resetsAt: z.string().nullable(),
    }),
  ),
  running: z.number().int(),
  maxConcurrentRuns: z.number().int(),
  queued: z.number().int(),
  /** Goals not finished yet, with their run budget. */
  goals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      runsUsed: z.number().int(),
      maxRuns: z.number().int(),
      budgetState: z.enum(BUDGET_STATES),
    }),
  ),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
