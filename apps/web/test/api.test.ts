import { healthResponseSchema } from '@agenta/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClientError, apiRequest, buildApiUrl } from '@/lib/api';

const respond = (status: number, body: unknown, raw = false): typeof fetch =>
  vi.fn(
    async () => new Response(raw ? (body as string) : JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;

describe('buildApiUrl', () => {
  it('prefixes /api and encodes query params, skipping null/undefined', () => {
    expect(buildApiUrl('/bots')).toBe('/api/bots');
    expect(buildApiUrl('bots')).toBe('/api/bots');
    expect(buildApiUrl('/api/health')).toBe('/api/health');
    expect(buildApiUrl('/runs', { botId: 'bot_1', status: undefined, x: null, n: 2, ok: true })).toBe(
      '/api/runs?botId=bot_1&n=2&ok=true',
    );
    expect(buildApiUrl('/threads/1/messages', { before: 'a b&c' })).toBe(
      '/api/threads/1/messages?before=a+b%26c',
    );
  });
});

describe('apiRequest', () => {
  it('parses a valid body with the schema', async () => {
    const body = { ok: true, version: '0.1.0', uptime: 1 };
    await expect(apiRequest('/health', healthResponseSchema, {}, respond(200, body))).resolves.toEqual(body);
  });

  it('sends JSON bodies with the method', async () => {
    const f = respond(200, { id: 'bot_1' });
    await apiRequest('/bots', z.object({ id: z.string() }), { method: 'POST', body: { name: 'x' } }, f);
    expect(f).toHaveBeenCalledWith(
      '/api/bots',
      expect.objectContaining({ method: 'POST', body: '{"name":"x"}' }),
    );
    const init = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('surfaces the runner typed error', async () => {
    const err = await apiRequest(
      '/bots/x',
      z.unknown(),
      {},
      respond(404, { error: { code: 'not_found', message: 'No bot' } }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 404, code: 'not_found', message: 'No bot' });
  });

  it('maps untyped HTTP errors, bad JSON, bad shapes and network failures', async () => {
    await expect(apiRequest('/x', z.unknown(), {}, respond(502, 'oops', true))).rejects.toMatchObject({
      code: 'invalid_json',
    });
    await expect(apiRequest('/x', z.unknown(), {}, respond(500, { nope: 1 }))).rejects.toMatchObject({
      code: 'http_error',
      status: 500,
    });
    await expect(
      apiRequest('/health', healthResponseSchema, {}, respond(200, { ok: 'yes' })),
    ).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(apiRequest('/x', z.unknown(), {}, failing)).rejects.toMatchObject({
      code: 'network_error',
      status: 0,
    });
  });

  it('accepts empty bodies when the schema allows it', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await expect(apiRequest('/x', z.undefined(), { method: 'DELETE' }, f)).resolves.toBeUndefined();
  });
});
