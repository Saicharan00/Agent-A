import { engineEventSchema } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockEngine, fakeClock } from '../../src/engines/mock';
import { EngineRegistry } from '../../src/engines/registry';
import { RunError } from '../../src/runs/service';
import { type Harness, makeHarness } from './helpers';

describe('RunService (session 1: queue, scheduling, execution)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.close());

  it('runs a mock turn end to end: events, reply message, session, usage', async () => {
    const botId = h.bot('Echo');
    const threadId = h.dm(botId);
    const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: '[mock:tools] look around' });
    expect(run).toMatchObject({ status: 'queued', engine: 'mock', trigger: 'user', hopCount: 0 });

    await h.service.idle();

    const done = h.repos.runs.get(run.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.error).toBeNull();
    expect(done.startedAt).not.toBeNull();
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.usage?.outputTokens).toBeGreaterThan(0);

    const events = h.repos.runs.listEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    for (const e of events) expect(engineEventSchema.parse(e.payload).type).toBe(e.type);
    expect(events[0]!.type).toBe('run.started');
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', payload: { status: 'succeeded' } });
    expect(events.filter((e) => e.type === 'run.finished')).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['tool.call', 'tool.result', 'file.changed']),
    );

    const reply = h.repos.messages.getByRun(run.id)!;
    expect(reply).toMatchObject({ threadId, authorType: 'bot', authorBotId: botId });
    expect(reply.contentMd).toContain('created hello.txt');

    expect(h.repos.sessions.get(botId, threadId)).toMatchObject({
      engine: 'mock',
      engineSessionId: `mock-${botId}-${threadId}`,
    });
  });

  it('publishes status changes, every event in seq order, and the reply', async () => {
    const botId = h.bot('Echo');
    const threadId = h.dm(botId);
    const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'hi there' });
    await h.service.idle();

    const onRun = h.published.filter((p) => p.channel === `run:${run.id}`).map((p) => p.event);
    expect(onRun.filter((e) => e.type === 'run.updated').map((e) => 'status' in e && e.status)).toEqual([
      'queued',
      'running',
      'succeeded',
    ]);
    const live = onRun.flatMap((e) => (e.type === 'run.event' ? [e] : []));
    const stored = h.repos.runs.listEvents(run.id);
    expect(live.map((e) => e.seq)).toEqual(stored.map((e) => e.seq));
    expect(live.map((e) => e.event)).toEqual(stored.map((e) => e.payload));

    const onThread = h.published.filter((p) => p.channel === `thread:${threadId}`).map((p) => p.event.type);
    expect(onThread).toContain('message.created');
    expect(h.published.some((p) => p.channel === `bot:${botId}`)).toBe(true);
  });

  it('batches event writes without gaps or reordering', async () => {
    h.close();
    h = makeHarness({ flushMs: 5 });
    const botId = h.bot('Echo');
    const run = h.service.enqueue({
      botId,
      threadId: h.dm(botId),
      trigger: 'user',
      prompt: 'one two three four five six',
    });
    const spy = vi.spyOn(h.repos.runs, 'appendEvents');
    await h.service.idle();
    const events = h.repos.runs.listEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    // run.started + deltas + text.final + usage + run.finished in fewer writes than events
    expect(spy.mock.calls.length).toBeLessThan(events.length);
    const text = events.flatMap((e) =>
      e.type === 'text.delta' ? [(e.payload as { text: string }).text] : [],
    );
    expect(text.join('')).toBe('You said: one two three four five six');
  });

  it('respects the global concurrency cap (default 2, then the settings value)', async () => {
    const bots = ['A', 'B', 'C', 'D'].map((n) => h.bot(n, 'claude'));
    for (const [i, botId] of bots.entries()) h.service.enqueue({ botId, trigger: 'user', prompt: `p${i}` });
    h.service.tick();
    await h.gate.whenRunning(2);
    h.service.tick();
    expect(h.gate.running().sort()).toEqual(['p0', 'p1']);
    expect(h.repos.runs.countByStatus('queued')).toBe(2);

    h.repos.settings.set('maxConcurrentRuns', 3);
    h.service.tick();
    await h.gate.whenRunning(3);
    expect(h.gate.running().sort()).toEqual(['p0', 'p1', 'p2']);

    h.gate.release('p0');
    await h.gate.whenRunning(3);
    expect(h.gate.running().sort()).toEqual(['p1', 'p2', 'p3']);
    for (const p of ['p1', 'p2', 'p3']) h.gate.release(p);
    await h.service.idle();
    expect(h.repos.runs.countByStatus('succeeded')).toBe(4);
  });

  it('runs one turn per bot at a time, FIFO, while other bots proceed', async () => {
    const a = h.bot('A', 'claude');
    const b = h.bot('B', 'claude');
    h.service.enqueue({ botId: a, trigger: 'user', prompt: 'a1' });
    h.service.enqueue({ botId: a, trigger: 'user', prompt: 'a2' });
    h.service.enqueue({ botId: b, trigger: 'user', prompt: 'b1' });
    h.service.tick();
    await h.gate.whenRunning(2);
    expect(h.gate.running().sort()).toEqual(['a1', 'b1']);

    h.gate.release('b1');
    await vi.waitFor(() => expect(h.repos.runs.countByStatus('succeeded')).toBe(1));
    h.service.tick();
    expect(h.gate.running()).toEqual(['a1']); // a2 still waits for a1, though a slot is free

    h.gate.release('a1');
    await h.gate.whenRunning(1);
    expect(h.gate.running()).toEqual(['a2']);
    h.gate.release('a2');
    await h.service.idle();
    expect(h.gate.started.map((i) => i.prompt)).toEqual(['a1', 'b1', 'a2']);
  });

  it('skips engines paused by a usage limit and starts them once the limit has passed', async () => {
    let now = new Date('2026-10-13T10:00:00.000Z');
    h.close();
    h = makeHarness({ now: () => now });
    h.repos.engineState.upsert('claude', { limitedUntil: '2026-10-13T10:30:00.000Z' });
    const limitedBot = h.bot('Limited', 'claude');
    const mockBot = h.bot('Mocky');
    const limitedRun = h.service.enqueue({ botId: limitedBot, trigger: 'user', prompt: 'later' });
    const mockRun = h.service.enqueue({ botId: mockBot, trigger: 'user', prompt: 'now' });
    await h.service.idle();
    expect(h.repos.runs.get(mockRun.id)!.status).toBe('succeeded');
    expect(h.repos.runs.get(limitedRun.id)!.status).toBe('queued');

    now = new Date('2026-10-13T10:31:00.000Z');
    h.service.tick();
    await h.gate.whenRunning(1);
    h.gate.release('later');
    await h.service.idle();
    expect(h.repos.runs.get(limitedRun.id)!.status).toBe('succeeded');
  });

  it('resumes the (bot, thread) session on the next turn, but not across engines', async () => {
    const botId = h.bot('Gate', 'claude');
    const threadId = h.dm(botId);
    h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'first' });
    await h.gate.whenRunning(1);
    h.gate.release('first');
    await h.service.idle();
    expect(h.repos.sessions.get(botId, threadId)?.engineSessionId).toBe('s-first');

    h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'second' });
    await h.gate.whenRunning(1);
    expect(h.gate.started[1]!.resumeSessionId).toBe('s-first');
    h.gate.release('second');
    await h.service.idle();

    h.repos.sessions.upsert({ botId, threadId, engine: 'codex', engineSessionId: 'codex-thread' });
    h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'third' });
    await h.gate.whenRunning(1);
    expect(h.gate.started[2]!.resumeSessionId).toBeUndefined();
    h.gate.release('third');
    await h.service.idle();
  });

  it('builds the engine input from the bot and thread', async () => {
    const botId = h.bot('Gate', 'claude');
    const threadId = h.dm(botId);
    h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'look' });
    await h.gate.whenRunning(1);
    const input = h.gate.started[0]!;
    expect(input).toMatchObject({
      threadId,
      prompt: 'look',
      cwd: '/home/bot/work',
      mcpConfigPath: '/home/bot/.agenta/mcp.json',
    });
    expect(input.bot.id).toBe(botId);
    expect(input.systemPromptAppend).toContain(`thread ${threadId} (dm)`);
    h.gate.release('look');
    await h.service.idle();
  });

  it('joins several complete assistant messages into one reply', async () => {
    const botId = h.bot('Gate', 'claude');
    const threadId = h.dm(botId);
    const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'multi' });
    await h.gate.whenRunning(1);
    h.gate.release('multi', [
      { type: 'text.final', text: 'Looking at the repo.' },
      { type: 'tool.call', callId: 'c1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool.result', callId: 'c1', output: 'README.md' },
      { type: 'text.final', text: 'Found a README.' },
    ]);
    await h.service.idle();
    expect(h.repos.messages.listByThread(threadId).map((m) => m.contentMd)).toEqual([
      'Looking at the repo.\n\nFound a README.',
    ]);
    const types = h.published.filter((p) => p.channel === `thread:${threadId}`).map((p) => p.event.type);
    expect(types.filter((t) => t.startsWith('message.'))).toEqual(['message.created', 'message.updated']);
    expect(h.repos.messages.getByRun(run.id)?.contentMd).toContain('Found a README.');
  });

  it('records engine failures with their message', async () => {
    const botId = h.bot('Echo');
    const threadId = h.dm(botId);
    const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: '[mock:error]' });
    await h.service.idle();
    expect(h.repos.runs.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'Mock engine failure (scripted [mock:error])',
    });
    expect(h.repos.runs.listEvents(run.id).at(-1)?.payload).toEqual({
      type: 'run.finished',
      status: 'failed',
      sessionId: `mock-${botId}-${threadId}`,
    });
    expect(h.repos.messages.getByRun(run.id)).toBeUndefined();
  });

  it('runs without a thread (no reply message, no session)', async () => {
    const botId = h.bot('Echo');
    const run = h.service.enqueue({ botId, trigger: 'schedule', prompt: '[mock:hello]' });
    await h.service.idle();
    expect(h.repos.runs.get(run.id)!.status).toBe('succeeded');
    expect(h.repos.sessions.listByBot(botId)).toEqual([]);
  });

  it('prepares the computer before the engine and releases it after', async () => {
    const order: string[] = [];
    h.close();
    h = makeHarness({
      prepare: async (bot, engine) => {
        order.push(`prepare ${bot.name} ${engine}`);
        return () => order.push('release');
      },
    });
    const botId = h.bot('Echo');
    h.service.enqueue({ botId, trigger: 'user', prompt: 'x' });
    await h.service.idle();
    expect(order).toEqual(['prepare Echo mock', 'release']);
  });

  it('fails the run when the computer cannot be prepared', async () => {
    h.close();
    h = makeHarness({
      prepare: async () => {
        throw Object.assign(new Error('image agenta-bot:latest is missing'), { statusCode: 409 });
      },
    });
    const botId = h.bot('Echo');
    const run = h.service.enqueue({ botId, trigger: 'user', prompt: 'x' });
    await h.service.idle();
    expect(h.repos.runs.get(run.id)).toMatchObject({
      status: 'failed',
      error: 'image agenta-bot:latest is missing',
    });
    expect(h.repos.runs.listEvents(run.id).map((e) => e.type)).toEqual(['error', 'run.finished']);
  });

  it('rejects unknown and archived bots', () => {
    expect(() => h.service.enqueue({ botId: 'bot_nope', trigger: 'user', prompt: 'x' })).toThrow(RunError);
    const botId = h.bot('Old');
    h.repos.bots.archive(botId);
    expect(() => h.service.enqueue({ botId, trigger: 'user', prompt: 'x' })).toThrow(/archived/);
  });

  it('uses the mock engine for every bot under the engine override', async () => {
    h.close();
    // As Playwright runs the runner: AGENTA_ENGINE_OVERRIDE=mock.
    h = makeHarness({
      engines: new EngineRegistry([new MockEngine({ clock: fakeClock(), tickMs: 1 })], 'mock'),
    });
    const botId = h.bot('Claudy', 'claude');
    const run = h.service.enqueue({ botId, trigger: 'user', prompt: '[mock:hello]' });
    expect(run.engine).toBe('mock');
    await h.service.idle();
    expect(h.repos.runs.get(run.id)!.status).toBe('succeeded');
  });
});
