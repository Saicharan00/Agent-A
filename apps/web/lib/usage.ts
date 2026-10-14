// Usage & limits dashboard (F28): API calls and the wording the /usage page shows.
import {
  type BudgetState,
  type UsageSettings,
  goalViewSchema,
  usageReportSchema,
  usageSettingsSchema,
} from '@agenta/shared';
import type { PillTone } from '@/components/status-pill';
import { apiRequest } from './api';

export const usageApi = {
  report: (days: number, tz: string) =>
    apiRequest(`/usage?days=${days}&tz=${encodeURIComponent(tz)}`, usageReportSchema),
  settings: () => apiRequest('/usage/settings', usageSettingsSchema),
  saveSettings: (body: UsageSettings) =>
    apiRequest('/usage/settings', usageSettingsSchema, { method: 'PUT', body }),
  setGoalBudget: (id: string, maxRuns: number) =>
    apiRequest(`/goals/${encodeURIComponent(id)}`, goalViewSchema, { method: 'PATCH', body: { maxRuns } }),
};

export const BUDGET_TONE: Record<BudgetState, PillTone> = {
  none: 'neutral',
  ok: 'ok',
  warn: 'warn',
  over: 'error',
};

/** "45 s", "12 min", "3 h 05 min". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "980", "12.3k", "4.1M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const formatUsd = (n: number) => `$${n.toFixed(2)}`;

/** The budget line of an engine or goal, e.g. "8 of 10 runs (80 %), nearly used up". */
export function budgetText(used: number, budget: number | null | undefined, state: BudgetState): string {
  if (!budget) return `${used} runs, no budget`;
  const pct = Math.round((used / budget) * 100);
  const base = `${used} of ${budget} runs (${pct} %)`;
  if (state === 'over') return `${base}, budget used up`;
  if (state === 'warn') return `${base}, nearly used up`;
  return base;
}
