// Typed client for the runner REST API. The browser always calls the web origin's /api,
// which Next rewrites to the runner (see docs/DECISIONS.md, F01).
import { apiErrorSchema, engineSettingsResponseSchema, healthResponseSchema } from '@agenta/shared';
import type { z } from 'zod';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export type ApiRequest = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
};

export function buildApiUrl(path: string, query?: ApiRequest['query']): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  const url = clean.startsWith('/api/') || clean === '/api' ? clean : `/api${clean}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/**
 * fetch + zod: resolves with the parsed body, or throws ApiClientError carrying the
 * runner's typed `{ error: { code, message } }` (or a synthetic code for network/shape failures).
 */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  req: ApiRequest = {},
  fetchImpl: typeof fetch = fetch,
): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetchImpl(buildApiUrl(path, req.query), {
      method: req.method ?? 'GET',
      headers: req.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      cache: 'no-store',
      signal: req.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiClientError(0, 'network_error', err instanceof Error ? err.message : 'Network error');
  }

  const text = await res.text();
  let json: unknown = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiClientError(res.status, 'invalid_json', `Expected JSON from ${path}`);
    }
  }

  if (!res.ok) {
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success)
      throw new ApiClientError(res.status, parsed.data.error.code, parsed.data.error.message);
    throw new ApiClientError(res.status, 'http_error', `HTTP ${res.status}`);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new ApiClientError(res.status, 'invalid_response', `Unexpected response from ${path}`);
  return parsed.data;
}

/** Endpoint helpers. Later features add bots, threads, runs… here. */
export const api = {
  health: (fetchImpl?: typeof fetch) => apiRequest('/health', healthResponseSchema, {}, fetchImpl),
  /** Engine auth status (F06). `verify` asks each CLI inside a running bot computer (no prompt is sent). */
  engines: (opts: { verify?: boolean } = {}, fetchImpl?: typeof fetch) =>
    apiRequest(
      '/settings/engines',
      engineSettingsResponseSchema,
      { query: { verify: opts.verify ? 1 : undefined } },
      fetchImpl,
    ),
};
