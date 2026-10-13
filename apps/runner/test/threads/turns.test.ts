import { join } from 'node:path';
import type { RunEventsBatchResponse, RunView, ThreadView } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine, fakeClock } from '../../src/engines/mock';
import { buildServer } from '../../src/server';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

// F13 session 2: thread settings, retrying a turn, read markers, batched run timelines.
describe('thread turns API', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let botId: string;
  let dm: string;

  beforeEach(async () => {
    h = makeHarness({ adapters: [new MockEngine({ clock: fakeClock(), tickMs: 1 })] });
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
    app = await buildServer(config, { repos: h.repos, runs: h.service, bots, threads });
    const bot = bots.create({ name: 'Helper', engine: 'mock' });
    botId = bot.id;
    dm = h.repos.threads.findDm(bot.id)!.id;
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  const send = async (content: string) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${dm}/messages`,
      payload: { content },
    });
    return res.json<{ runs: RunView[] }>().runs[0]!;
  };

  it('toggles Explain mode and renames, validating the body', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/${dm}`,
      payload: { explainMode: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ThreadView>()).toMatchObject({ explainMode: true, title: 'Helper' });
    expect(h.repos.threads.get(dm)!.explainMode).toBe(true);
    for (const payload of [{}, { explainMode: 'yes' }, { kind: 'group' }]) {
      const bad = await app.inject({ method: 'PATCH', url: `/api/threads/${dm}`, payload });
      expect(bad.statusCode).toBe(400);
    }
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/threads/thr_x', payload: { title: 'x' } })).statusCode,
    ).toBe(404);
  });

  it('the next turn gets the Explain mode instructions; a plain DM turn is the message as typed', async () => {
    const plain = await send('plain question');
    expect(h.repos.runs.get(plain.id)!.prompt).toBe('plain question');
    await h.service.idle();
    await app.inject({ method: 'PATCH', url: `/api/threads/${dm}`, payload: { explainMode: true } });
    const explained = await send('why?');
    const prompt = h.repos.runs.get(explained.id)!.prompt;
    expect(prompt).toContain('Explain mode is on');
    expect(prompt).toContain('why?');
    // The bot's own earlier reply is not repeated back to it.
    expect(prompt).not.toContain('You said');
    await h.service.idle();
  });

  it('retries the latest finished turn with the same prompt, linked to the original', async () => {
    const first = await send('[mock:error] try');
    await h.service.idle();
    expect(h.repos.runs.get(first.id)!.status).toBe('failed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${dm}/retry`,
      payload: { runId: first.id },
    });
    expect(res.statusCode).toBe(201);
    const retry = res.json<RunView>();
    expect(retry).toMatchObject({ retryOfRunId: first.id, trigger: 'user', status: 'queued', botId });
    expect(h.repos.runs.get(retry.id)!.prompt).toBe('[mock:error] try');

    await h.service.idle();
    // An older turn → refused; a retry of a retry links to the original turn.
    const old = await app.inject({
      method: 'POST',
      url: `/api/threads/${dm}/retry`,
      payload: { runId: first.id },
    });
    expect(old.json()).toMatchObject({ error: { code: 'not_last_turn' } });
    const again = await app.inject({
      method: 'POST',
      url: `/api/threads/${dm}/retry`,
      payload: { runId: retry.id },
    });
    expect(again.json<RunView>().retryOfRunId).toBe(first.id);
    await h.service.idle();

    // A turn still in progress → refused.
    h.service.stop();
    const pending = h.repos.runs.create({
      botId,
      threadId: dm,
      trigger: 'user',
      engine: 'mock',
      prompt: 'x',
    });
    const active = await app.inject({
      method: 'POST',
      url: `/api/threads/${dm}/retry`,
      payload: { runId: pending.id },
    });
    expect(active.json()).toMatchObject({ error: { code: 'run_active' } });

    const other = h.repos.threads.create({ kind: 'dm', title: 'other' });
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/threads/${other.id}/retry`,
      payload: { runId: first.id },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('counts unread bot messages until the thread is read, and announces new messages on global', async () => {
    await send('[mock:hello]');
    await h.service.idle();
    const unread = await app.inject({ url: '/api/threads/unread' });
    expect(unread.json()).toEqual({ counts: { [dm]: 1 } });
    const activity = h.published.filter((p) => p.channel === 'global' && p.event.type === 'thread.activity');
    expect(activity.map((a) => (a.event as { authorType: string }).authorType)).toEqual(['user', 'bot']);

    const read = await app.inject({ method: 'POST', url: `/api/threads/${dm}/read` });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ lastReadAt: string }>().lastReadAt).toBe(h.repos.threads.get(dm)!.lastReadAt);
    expect((await app.inject({ url: '/api/threads/unread' })).json()).toEqual({ counts: {} });
    expect((await app.inject({ method: 'POST', url: '/api/threads/thr_x/read' })).statusCode).toBe(404);
  });

  it('returns compacted timelines for several runs', async () => {
    const tools = await send('[mock:tools]');
    await h.service.idle();
    const hello = await send('[mock:hello]');
    await h.service.idle();
    const res = await app.inject({ url: `/api/runs/events?ids=${tools.id},${hello.id},run_unknown` });
    expect(res.statusCode).toBe(200);
    const body = res.json<RunEventsBatchResponse>();
    expect(Object.keys(body.runs).sort()).toEqual([tools.id, hello.id].sort());
    const types = body.runs[tools.id]!.events.map((e) => e.event.type);
    expect(types).toEqual([
      'run.started',
      'thinking',
      'text.delta', // merged
      'tool.call',
      'tool.result',
      'tool.call',
      'tool.result',
      'file.changed',
      'text.delta',
      'text.final',
      'usage',
      'run.finished',
    ]);
    const seqs = body.runs[tools.id]!.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(body.runs[hello.id]!.status).toBe('succeeded');

    expect((await app.inject({ url: '/api/runs/events?ids=' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/runs/events?ids=../etc' })).statusCode).toBe(400);
  });
});
