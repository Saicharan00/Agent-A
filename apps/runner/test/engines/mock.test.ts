import { type EngineEvent, engineEventSchema } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { MockEngine, fakeClock, pickScenario, wordChunks } from '../../src/engines/mock';
import { EngineNotAvailableError, EngineRegistry } from '../../src/engines/registry';
import type { EngineRunInput } from '../../src/engines/types';

const input = (prompt: string, over: Partial<EngineRunInput> = {}): EngineRunInput => ({
  bot: { id: 'bot_1', name: 'Echo Bot', slug: 'echo-bot', role: '', engine: 'mock', model: null },
  threadId: 'thr_1',
  prompt,
  systemPromptAppend: '',
  mcpConfigPath: '/home/bot/.agenta/mcp.json',
  cwd: '/home/bot/work',
  ...over,
});

async function collect(engine: MockEngine, prompt: string, signal = new AbortController().signal, over = {}) {
  const events: EngineEvent[] = [];
  for await (const e of engine.run(input(prompt, over), signal)) events.push(engineEventSchema.parse(e));
  return events;
}

const types = (es: EngineEvent[]) => es.map((e) => e.type);
const finished = (es: EngineEvent[]) => es.at(-1);
const deltas = (es: EngineEvent[]) => es.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');
const finals = (es: EngineEvent[]) => es.flatMap((e) => (e.type === 'text.final' ? [e.text] : []));

/** Invariants every scenario must keep. */
function checkShape(es: EngineEvent[]) {
  expect(es[0]).toMatchObject({ type: 'run.started', engine: 'mock' });
  expect(es.filter((e) => e.type === 'run.finished')).toHaveLength(1);
  expect(es.at(-1)!.type).toBe('run.finished');
  const calls = es.flatMap((e) => (e.type === 'tool.call' ? [e.callId] : []));
  const results = es.flatMap((e) => (e.type === 'tool.result' ? [e.callId] : []));
  expect(results).toEqual(calls);
}

describe('MockEngine scenarios', () => {
  const engine = () => new MockEngine({ clock: fakeClock(), tickMs: 10 });

  it('picks scenarios by keyword', () => {
    expect(pickScenario('please [mock:tools] now')).toBe('tools');
    expect(pickScenario('[MOCK:Hello]')).toBe('hello');
    expect(pickScenario('[mock:nope] hi')).toBe('echo');
    expect(wordChunks('a  b c').join('')).toBe('a  b c');
  });

  it('hello: streams word by word, then final text, usage, succeeded', async () => {
    const es = await collect(engine(), '[mock:hello]');
    checkShape(es);
    const text = "Hello! I'm Echo Bot, running on the mock engine. How can I help?";
    expect(deltas(es)).toBe(text);
    expect(es.filter((e) => e.type === 'text.delta').length).toBe(wordChunks(text).length);
    expect(finals(es)).toEqual([text]);
    expect(types(es).slice(-3)).toEqual(['text.final', 'usage', 'run.finished']);
    expect(finished(es)).toEqual({
      type: 'run.finished',
      status: 'succeeded',
      sessionId: 'mock-bot_1-thr_1',
    });
  });

  it('tools: thinking, two tool calls with results, file.changed, final', async () => {
    const es = await collect(engine(), '[mock:tools]');
    checkShape(es);
    const keyTypes = types(es).filter((t) => t !== 'text.delta');
    expect(keyTypes).toEqual([
      'run.started',
      'thinking',
      'tool.call',
      'tool.result',
      'tool.call',
      'tool.result',
      'file.changed',
      'text.final',
      'usage',
      'run.finished',
    ]);
    expect(es.find((e) => e.type === 'tool.call')).toMatchObject({
      name: 'Bash',
      input: { command: 'ls -la /home/bot/work' },
    });
    expect(es.find((e) => e.type === 'file.changed')).toEqual({
      type: 'file.changed',
      path: '/home/bot/work/hello.txt',
      change: 'created',
    });
    expect(finals(es)[0]).toBe(deltas(es));
    expect(finished(es)).toMatchObject({ status: 'succeeded' });
  });

  it('error: partial text, error event, failed', async () => {
    const es = await collect(engine(), '[mock:error]');
    checkShape(es);
    expect(types(es).filter((t) => t !== 'text.delta')).toEqual(['run.started', 'error', 'run.finished']);
    expect(finished(es)).toMatchObject({ status: 'failed' });
  });

  it('limit: limit.hit with resetsAt 2 minutes ahead, limited', async () => {
    const clock = fakeClock(new Date('2026-10-12T14:03:00.000Z'));
    const es = await collect(new MockEngine({ clock }), 'go [mock:limit]');
    checkShape(es);
    expect(types(es)).toEqual(['run.started', 'limit.hit', 'run.finished']);
    expect(es[1]).toMatchObject({ engine: 'mock', resetsAt: '2026-10-12T14:05:00.000Z' });
    expect(finished(es)).toMatchObject({ status: 'limited' });
  });

  it('slow: takes 20 s of (virtual) time and completes', async () => {
    const clock = fakeClock();
    const es = await collect(new MockEngine({ clock }), '[mock:slow]');
    checkShape(es);
    expect(clock.elapsedMs()).toBe(20_000);
    expect(finals(es)[0]).toBe(deltas(es));
    expect(finished(es)).toMatchObject({ status: 'succeeded' });
  });

  it('slow: aborting mid-run ends promptly with cancelled', async () => {
    const ac = new AbortController();
    const engine = new MockEngine({ slowMs: 20_000 }); // real clock
    const es: EngineEvent[] = [];
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    for await (const e of engine.run(input('[mock:slow]'), ac.signal)) es.push(e);
    expect(Date.now() - started).toBeLessThan(1_500);
    checkShape(es);
    expect(finished(es)).toMatchObject({ status: 'cancelled' });
    expect(es.some((e) => e.type === 'text.final')).toBe(false);
  });

  it('an already-aborted signal yields started → cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const es = await collect(engine(), '[mock:hello]', ac.signal);
    expect(types(es)).toEqual(['run.started', 'run.finished']);
    expect(finished(es)).toMatchObject({ status: 'cancelled' });
  });

  it('browser: a Playwright MCP navigate with its URL', async () => {
    const es = await collect(engine(), '[mock:browser] open example.com');
    checkShape(es);
    expect(es).toContainEqual({
      type: 'tool.call',
      callId: 'mock-browser-1',
      name: 'mcp__playwright__browser_navigate',
      input: { url: 'https://example.com/' },
    });
    expect(finished(es)).toMatchObject({ status: 'succeeded' });
  });

  it('delegate: platform MCP tool calls (stub result until F17, injectable)', async () => {
    const stub = await collect(engine(), '[mock:delegate]');
    checkShape(stub);
    expect(stub.filter((e) => e.type === 'tool.call').map((e) => (e as { name: string }).name)).toEqual([
      'mcp__agenta__create_task',
      'mcp__agenta__message_bot',
    ]);
    expect(stub.find((e) => e.type === 'tool.result')).toMatchObject({
      output: expect.stringMatching(/F17/),
    });

    const calls: string[] = [];
    const wired = new MockEngine({
      clock: fakeClock(),
      platform: {
        call: async (name) => {
          calls.push(name);
          if (name.endsWith('message_bot')) throw new Error('bot not found');
          return 'task tsk_1 created';
        },
      },
    });
    const es = await collect(wired, '[mock:delegate]');
    expect(calls).toHaveLength(2);
    expect(es.filter((e) => e.type === 'tool.result')).toEqual([
      { type: 'tool.result', callId: 'mock-mcp-1', output: 'task tsk_1 created' },
      { type: 'tool.result', callId: 'mock-mcp-2', output: 'bot not found', isError: true },
    ]);
  });

  it('default: echoes the prompt; resume keeps the given session id', async () => {
    const es = await collect(engine(), 'what is 2+2?', undefined, { resumeSessionId: 'mock-prev' });
    checkShape(es);
    expect(finals(es)).toEqual(['You said: what is 2+2?']);
    expect(es[0]).toMatchObject({ sessionId: 'mock-prev' });
    expect(finished(es)).toMatchObject({ sessionId: 'mock-prev', status: 'succeeded' });
  });
});

describe('EngineRegistry', () => {
  const mock = new MockEngine();
  it('uses the bot engine, or mock for every bot under AGENTA_ENGINE_OVERRIDE=mock', () => {
    const normal = new EngineRegistry([mock]);
    expect(normal.get({ engine: 'mock' })).toBe(mock);
    expect(() => normal.get({ engine: 'claude' })).toThrow(EngineNotAvailableError);

    const forced = new EngineRegistry([mock], 'mock');
    expect(forced.effectiveEngine({ engine: 'claude' })).toBe('mock');
    expect(forced.get({ engine: 'codex' })).toBe(mock);
  });
});
