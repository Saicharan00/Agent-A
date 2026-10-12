import { describe, expect, it } from 'vitest';
import { fetchRunnerStatus } from '@/lib/runner';

const respond = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('fetchRunnerStatus', () => {
  it('reports ok for a healthy runner', async () => {
    const s = await fetchRunnerStatus(respond(200, { ok: true, version: '0.1.0', uptime: 3 }));
    expect(s).toEqual({ state: 'ok', health: { ok: true, version: '0.1.0', uptime: 3 } });
  });

  it('reports down on HTTP errors', async () => {
    expect(await fetchRunnerStatus(respond(502, {}))).toEqual({ state: 'down', reason: 'HTTP 502' });
  });

  it('reports down on malformed bodies', async () => {
    const s = await fetchRunnerStatus(respond(200, { hello: 'x' }));
    expect(s.state).toBe('down');
  });

  it('reports down when the network fails', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await fetchRunnerStatus(failing)).toEqual({ state: 'down', reason: 'ECONNREFUSED' });
  });
});
