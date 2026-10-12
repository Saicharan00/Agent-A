import type { HealthResponse } from '@agenta/shared';
import { api } from './api';

export type RunnerStatus = { state: 'ok'; health: HealthResponse } | { state: 'down'; reason: string };

/** Never throws: maps any failure to `{ state: 'down' }` for the status pill. */
export async function fetchRunnerStatus(fetchImpl: typeof fetch = fetch): Promise<RunnerStatus> {
  try {
    const health = await api.health(fetchImpl);
    if (!health.ok) return { state: 'down', reason: 'Runner reported not ok' };
    return { state: 'ok', health };
  } catch (err) {
    if (err instanceof Error && 'code' in err) {
      const e = err as Error & { code: string; status: number };
      if (e.code === 'http_error') return { state: 'down', reason: `HTTP ${e.status}` };
      if (e.code === 'invalid_response' || e.code === 'invalid_json')
        return { state: 'down', reason: 'Malformed health response' };
    }
    return { state: 'down', reason: err instanceof Error ? err.message : 'Unreachable' };
  }
}
