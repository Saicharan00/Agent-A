import { healthResponseSchema, type HealthResponse } from '@agenta/shared';

export type RunnerStatus = { state: 'ok'; health: HealthResponse } | { state: 'down'; reason: string };

/** Calls the runner through the web origin's /api proxy. */
export async function fetchRunnerStatus(fetchImpl: typeof fetch = fetch): Promise<RunnerStatus> {
  try {
    const res = await fetchImpl('/api/health', { cache: 'no-store' });
    if (!res.ok) return { state: 'down', reason: `HTTP ${res.status}` };
    const parsed = healthResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { state: 'down', reason: 'Malformed health response' };
    if (!parsed.data.ok) return { state: 'down', reason: 'Runner reported not ok' };
    return { state: 'ok', health: parsed.data };
  } catch (err) {
    return { state: 'down', reason: err instanceof Error ? err.message : 'Unreachable' };
  }
}
