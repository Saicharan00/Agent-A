import { join } from 'node:path';
import type { ScheduleRunView, ScheduleView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { ScheduleService, nextCronRun } from '../../src/schedules/service';
import { buildServer } from '../../src/server';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

describe('scheduled tasks (F26)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let schedules: ScheduleService;
  let now: Date;
  let botId: string;

  beforeEach(async () => {
    now = new Date('2026-10-14T12:00:00.000Z'); // Wednesday 08:00 in New York (EDT)
    h = makeHarness();
    const botsDir = join(h.dir, 'bots');
    const bots = new BotService({ repos: h.repos, bus: h.bus, log: silent, botsDir, runs: h.service });
    const threads = new ThreadService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      bots,
      runs: h.service,
    });
    schedules = new ScheduleService({
      repos: h.repos,
      threads,
      effectiveEngine: (b) => b.engine,
      bus: h.bus,
      log: silent,
      now: () => now,
    });
    app = await buildServer(config, { repos: h.repos, runs: h.service, schedules });
    botId = h.bot('Planner');
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const create = (body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { name: 'Daily plan', botId, cron: '45 8 * * 1-5', prompt: 'Plan my day', ...body },
    });
  const history = async (id: string) =>
    (await app.inject({ url: `/api/schedules/${id}/runs` })).json<ScheduleRunView[]>();
  const at = (iso: string) => void (now = new Date(iso));
  const runCount = () => h.repos.runs.list({}).length;

  it('computes the next run in the schedule time zone (default America/New_York)', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    expect(res.json<ScheduleView>()).toMatchObject({
      timezone: 'America/New_York',
      enabled: true,
      nextRunAt: '2026-10-14T12:45:00.000Z',
    });
    // Friday 16:45 in New York → 20:45 UTC.
    expect(nextCronRun('45 16 * * 5', 'America/New_York', now)).toBe('2026-10-16T20:45:00.000Z');
  });

  it('rejects a bad cron, a seconds field, an unknown time zone and an unknown bot', async () => {
    expect((await create({ cron: 'every day' })).json().error.code).toBe('invalid_cron');
    expect((await create({ cron: '0 45 8 * * 1-5' })).json().error.code).toBe('invalid_cron');
    const tz = await create({ timezone: 'Mars/Olympus' });
    expect(tz.statusCode).toBe(400);
    expect(tz.json().error.message).toMatch(/time zone/);
    expect((await create({ botId: 'bot_nope' })).statusCode).toBe(404);
    expect(h.repos.schedules.list()).toHaveLength(0);
  });

  it('fires when due: a new thread with the prompt, a schedule-triggered run, then the next occurrence', async () => {
    const s = (await create()).json<ScheduleView>();
    expect(schedules.tick()).toHaveLength(0);
    at('2026-10-14T12:45:10.000Z');
    const [fired] = schedules.tick();
    expect(fired).toMatchObject({ outcome: 'started', manual: false });
    const run = h.repos.runs.get(fired!.runId!)!;
    expect(run).toMatchObject({ botId, trigger: 'schedule', threadId: fired!.threadId });
    const thread = h.repos.threads.get(fired!.threadId!)!;
    expect(thread.kind).toBe('scheduled');
    expect(thread.title).toMatch(/^Daily plan · Oct 14, 2026/);
    expect(h.repos.messages.latest(thread.id)?.contentMd).toContain('Plan my day');
    expect(schedules.get(s.id)).toMatchObject({
      lastRunAt: '2026-10-14T12:45:10.000Z',
      nextRunAt: '2026-10-15T12:45:00.000Z',
    });
    await h.service.idle();
    expect((await history(s.id))[0]).toMatchObject({ outcome: 'started', runStatus: 'succeeded' });
    expect(h.published.some((p) => p.event.type === 'schedule.changed')).toBe(true);
  });

  it('skips while the engine is limited; with catch-up it retries after the reset', async () => {
    const off = (await create({ name: 'off' })).json<ScheduleView>();
    const on = (await create({ name: 'on', catchUp: true })).json<ScheduleView>();
    h.repos.engineState.upsert('mock', { limitedUntil: '2026-10-14T14:00:00.000Z' });
    at('2026-10-14T12:45:05.000Z');
    const fired = schedules.tick();
    expect(fired.map((r) => r.outcome)).toEqual(['skipped', 'skipped']);
    expect(fired[0]!.reason).toBe('mock is limited until 2026-10-14T14:00:00.000Z');
    expect(fired[1]!.reason).toMatch(/retrying after the reset$/);
    expect(schedules.get(off.id).nextRunAt).toBe('2026-10-15T12:45:00.000Z');
    expect(schedules.get(on.id).nextRunAt).toBe('2026-10-14T14:00:00.000Z');
    expect(runCount()).toBe(0);

    at('2026-10-14T14:00:20.000Z');
    const retried = schedules.tick();
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ scheduleId: on.id, outcome: 'started' });
    expect(schedules.get(on.id).nextRunAt).toBe('2026-10-15T12:45:00.000Z');
  });

  it('after a sleep, a missed run is skipped, or caught up once when catch-up is on', async () => {
    const off = (await create({ name: 'off' })).json<ScheduleView>();
    const on = (await create({ name: 'on', catchUp: true })).json<ScheduleView>();
    at('2026-10-16T09:00:00.000Z'); // two days later: two occurrences missed
    const fired = schedules.tick();
    const offRun = fired.find((r) => r.scheduleId === off.id)!;
    expect(offRun.outcome).toBe('skipped');
    expect(offRun.reason).toMatch(/^Missed at 2026-10-14T12:45/);
    expect(fired.find((r) => r.scheduleId === on.id)).toMatchObject({ outcome: 'started' });
    expect(runCount()).toBe(1);
    for (const id of [off.id, on.id]) expect(schedules.get(id).nextRunAt).toBe('2026-10-16T12:45:00.000Z');
    expect(schedules.tick()).toHaveLength(0);
  });

  it('skips while the previous run of the schedule is still going', async () => {
    const s = (await create({ cron: '*/5 * * * *' })).json<ScheduleView>();
    at('2026-10-14T12:05:00.000Z');
    const [first] = schedules.tick();
    await h.service.idle();
    h.db.$client.prepare("update runs set status = 'running' where id = ?").run(first!.runId);
    at('2026-10-14T12:10:00.000Z');
    expect(schedules.tick()[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'The previous run of this schedule is still going',
    });
    expect(schedules.get(s.id).nextRunAt).toBe('2026-10-14T12:15:00.000Z');
  });

  it('Run now posts in the target thread without moving the timer; disabled schedules never fire', async () => {
    const thread = h.dm(botId);
    const s = (await create({ threadId: thread, enabled: false })).json<ScheduleView>();
    expect(s.nextRunAt).toBeNull();
    const res = await app.inject({ method: 'POST', url: `/api/schedules/${s.id}/run` });
    expect(res.json<ScheduleRunView>()).toMatchObject({ outcome: 'started', manual: true, threadId: thread });
    expect(h.repos.messages.latest(thread)?.contentMd).toBe('**Scheduled: Daily plan**\n\nPlan my day');
    expect(schedules.get(s.id).nextRunAt).toBeNull();
    at('2026-10-20T12:00:00.000Z');
    expect(schedules.tick()).toHaveLength(0);

    const enabled = await app.inject({
      method: 'PATCH',
      url: `/api/schedules/${s.id}`,
      payload: { enabled: true },
    });
    expect(enabled.json<ScheduleView>().nextRunAt).toBe('2026-10-20T12:45:00.000Z');
    const del = await app.inject({ method: 'DELETE', url: `/api/schedules/${s.id}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ url: `/api/schedules/${s.id}` })).statusCode).toBe(404);
  });

  it('records a failure when the bot was archived', async () => {
    const s = (await create()).json<ScheduleView>();
    h.repos.bots.archive(botId);
    const res = await app.inject({ method: 'POST', url: `/api/schedules/${s.id}/run` });
    expect(res.json<ScheduleRunView>()).toMatchObject({ outcome: 'failed', reason: 'The bot is archived' });
  });
});
