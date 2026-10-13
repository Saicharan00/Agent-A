import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import type { RunEventsResponse } from '../../src/runs/routes';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness } from './helpers';

describe('runs API', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    h = makeHarness({ adapters: [new MockEngine({ slowMs: 60_000, tickMs: 1 })] });
    app = await buildServer(config, { repos: h.repos, runs: h.service });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  it('replays events in order with no gaps from any afterSeq', async () => {
    const botId = h.bot('Echo');
    const run = h.service.enqueue({ botId, threadId: h.dm(botId), trigger: 'user', prompt: '[mock:tools]' });
    await h.service.idle();

    const all = (await app.inject({ url: `/api/runs/${run.id}/events` })).json<RunEventsResponse>();
    expect(all.status).toBe('succeeded');
    const n = all.events.length;
    expect(all.events.map((e) => e.seq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));

    const tail = (
      await app.inject({ url: `/api/runs/${run.id}/events?afterSeq=3` })
    ).json<RunEventsResponse>();
    expect(tail.events.map((e) => e.seq)).toEqual(all.events.slice(3).map((e) => e.seq));
    expect(tail.events[0]!.payload).toEqual(all.events[3]!.payload);

    const page = (
      await app.inject({ url: `/api/runs/${run.id}/events?afterSeq=1&limit=2` })
    ).json<RunEventsResponse>();
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);

    const bad = await app.inject({ url: `/api/runs/${run.id}/events?afterSeq=-1` });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_query');
  });

  it('lists and gets runs with filters', async () => {
    const a = h.bot('A');
    const b = h.bot('B');
    const ok = h.service.enqueue({ botId: a, trigger: 'user', prompt: 'hi' });
    const bad = h.service.enqueue({ botId: b, trigger: 'user', prompt: '[mock:error]' });
    await h.service.idle();

    const byBot = (await app.inject({ url: `/api/runs?botId=${a}` })).json<{ id: string }[]>();
    expect(byBot.map((r) => r.id)).toEqual([ok.id]);
    const byStatus = (await app.inject({ url: '/api/runs?status=failed,cancelled' })).json<
      { id: string }[]
    >();
    expect(byStatus.map((r) => r.id)).toEqual([bad.id]);
    const both = (await app.inject({ url: '/api/runs?status=failed&status=succeeded' })).json<unknown[]>();
    expect(both).toHaveLength(2);
    expect((await app.inject({ url: '/api/runs?status=nope' })).statusCode).toBe(400);

    const one = await app.inject({ url: `/api/runs/${ok.id}` });
    expect(one.json()).toMatchObject({ id: ok.id, status: 'succeeded', engine: 'mock' });
    const missing = await app.inject({ url: '/api/runs/run_missing' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('run_not_found');
    expect((await app.inject({ url: '/api/runs/run_missing/events' })).statusCode).toBe(404);
  });

  it('POST /runs/:id/cancel stops a running run; 409 once finished, 404 when unknown', async () => {
    const botId = h.bot('Slow');
    const run = h.service.enqueue({ botId, trigger: 'user', prompt: '[mock:slow]' });
    await new Promise((r) => setTimeout(r, 30));
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: run.id, status: 'cancelled' });

    const again = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('run_finished');
    const unknown = await app.inject({ method: 'POST', url: '/api/runs/run_missing/cancel' });
    expect(unknown.statusCode).toBe(404);
  });
});
