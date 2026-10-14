import { runs as runsTable } from '@agenta/db';
import { type UsageReport, type UsageSettings, budgetState } from '@agenta/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { buildServer } from '../../src/server';
import { dayKeys } from '../../src/usage/service';
import { type Harness, makeHarness } from '../runs/helpers';

describe('usage & limits (F28)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    h = makeHarness();
    app = await buildServer(config, { repos: h.repos, runs: h.service });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const report = async (q = '') => (await app.inject({ url: `/api/usage${q}` })).json<UsageReport>();
  const put = (body: unknown) =>
    app.inject({ method: 'PUT', url: '/api/usage/settings', payload: body as object });

  /** A finished run, created `daysAgo` days back. */
  function seed(
    botId: string,
    engine: 'claude' | 'codex',
    opts: { daysAgo?: number; status?: 'succeeded' | 'limited'; error?: string; tokens?: number } = {},
  ) {
    const run = h.repos.runs.create({ botId, trigger: 'user', engine, prompt: 'p' });
    h.repos.runs.markRunning(run.id);
    h.repos.runs.finish(run.id, {
      status: opts.status ?? 'succeeded',
      error: opts.error ?? null,
      usage: { inputTokens: opts.tokens ?? 0, outputTokens: 1, costUsdEquivalent: 0.5 },
    });
    const at = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString();
    h.db.update(runsTable).set({ createdAt: at, startedAt: at }).where(eq(runsTable.id, run.id)).run();
    return run.id;
  }

  it('budgetState: none without a budget, warn from 80 %, over at the budget', () => {
    expect(budgetState(5, null)).toBe('none');
    expect(budgetState(7, 10)).toBe('ok');
    expect(budgetState(8, 10)).toBe('warn');
    expect(budgetState(10, 10)).toBe('over');
  });

  it('dayKeys counts calendar days, so a DST change never skips or repeats a day', () => {
    // 2026-11-01 01:00 is when New York falls back; 23:30 local on Nov 1 is 04:30 UTC on Nov 2.
    expect(dayKeys(new Date('2026-11-02T04:30:00Z'), 3, 'America/New_York')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
  });

  it('reports seeded runs per day, engine and bot, with limit hits and their reset times', async () => {
    const ada = h.bot('Ada', 'claude');
    const cody = h.bot('Cody', 'codex');
    seed(ada, 'claude', { tokens: 100 });
    seed(ada, 'claude', { daysAgo: 1, tokens: 50 });
    seed(cody, 'codex', { daysAgo: 2 });
    seed(cody, 'codex', { daysAgo: 30 }); // outside the 14-day window
    seed(ada, 'claude', {
      status: 'limited',
      error: 'Usage limit reached; claude paused until 2026-10-14T15:00:00.000Z',
    });

    const r = await report('?days=14');
    expect(r.perDay).toHaveLength(14);
    expect(r.perDay.at(-1)!.runs).toEqual({ claude: 2 });
    expect(r.perDay.at(-2)!.runs).toEqual({ claude: 1 });
    expect(r.perDay.at(-3)!.runs).toEqual({ codex: 1 });
    expect(r.totals).toMatchObject({ runs: 4, inputTokens: 150, outputTokens: 4, costUsdEquivalent: 2 });
    expect(r.perEngine.map((e) => [e.engine, e.runs, e.last24h])).toEqual([
      ['claude', 3, 2],
      ['codex', 1, 0],
    ]);
    expect(r.perBot.map((b) => [b.name, b.runs])).toEqual([
      ['Ada', 3],
      ['Cody', 1],
    ]);
    expect(r.limitHits).toEqual([
      expect.objectContaining({ botName: 'Ada', engine: 'claude', resetsAt: '2026-10-14T15:00:00.000Z' }),
    ]);
    expect(r).toMatchObject({ running: 0, queued: 0, maxConcurrentRuns: 2 });
  });

  it('warns when the soft daily budget reaches 80 %', async () => {
    const ada = h.bot('Ada', 'claude');
    for (let i = 0; i < 4; i++) seed(ada, 'claude');
    expect(
      (await put({ maxConcurrentRuns: 2, budgets: { claude: { dailyRuns: 6, hardStop: false } } }))
        .statusCode,
    ).toBe(200);
    expect((await report()).perEngine[0]).toMatchObject({ engine: 'claude', budgetState: 'ok' });
    seed(ada, 'claude');
    expect((await report()).perEngine[0]).toMatchObject({ last24h: 5, budgetState: 'warn' });
  });

  it('a hard budget holds new runs in the queue until it is raised', async () => {
    await put({ maxConcurrentRuns: 2, budgets: { claude: { dailyRuns: 1, hardStop: true } } });
    const a = h.bot('Ada', 'claude');
    const b = h.bot('Bea', 'claude');
    h.service.enqueue({ botId: a, threadId: h.dm(a), trigger: 'user', prompt: 'one' });
    await h.gate.whenRunning(1);
    h.gate.release('one');
    await h.service.idle();
    const held = h.service.enqueue({ botId: b, threadId: h.dm(b), trigger: 'user', prompt: 'two' });
    await h.service.idle();
    expect(h.repos.runs.get(held.id)?.status).toBe('queued');
    expect((await report()).perEngine[0]).toMatchObject({ budgetState: 'over' });

    const res = await put({ maxConcurrentRuns: 3, budgets: { claude: { dailyRuns: 5, hardStop: true } } });
    expect(res.json<UsageSettings>()).toEqual({
      maxConcurrentRuns: 3,
      budgets: { claude: { dailyRuns: 5, hardStop: true } },
    });
    await h.gate.whenRunning(1);
    h.gate.release('two');
    await h.service.idle();
    expect(h.repos.runs.get(held.id)?.status).toBe('succeeded');
  });

  it('rejects bad settings; an unknown time zone falls back to UTC', async () => {
    expect((await put({ maxConcurrentRuns: 0, budgets: {} })).statusCode).toBe(400);
    expect(
      (await put({ maxConcurrentRuns: 2, budgets: { claude: { dailyRuns: -1, hardStop: false } } }))
        .statusCode,
    ).toBe(400);
    const odd = await app.inject({ url: '/api/usage?tz=Etc/Unknown' });
    expect(odd.json<UsageReport>().tz).toBe('UTC');
  });
});
