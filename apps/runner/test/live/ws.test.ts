import type { LiveRunEvent, LiveServerMessage } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { LiveHub } from '../../src/live/hub';
import { buildServer } from '../../src/server';
import { type Harness, makeHarness, silent } from '../runs/helpers';

/** A real WebSocket (Node 22's global client) with a queue of parsed frames. */
async function connect(url: string, headers?: Record<string, string>) {
  const frames: LiveServerMessage[] = [];
  const waiters: (() => void)[] = [];
  const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
  ws.onmessage = (ev) => {
    frames.push(JSON.parse(String(ev.data)) as LiveServerMessage);
    for (const w of waiters.splice(0)) w();
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('socket error'));
  });
  return {
    ws,
    frames,
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
    async until(pred: (frames: LiveServerMessage[]) => boolean, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!pred(frames)) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(frames.slice(-3))}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
        ws.close();
      }),
  };
}

const runEvents = (frames: LiveServerMessage[]): LiveRunEvent[] =>
  frames.flatMap((f) => (f.type === 'event' && f.event.type === 'run.event' ? [f.event] : []));

describe('GET /ws (integration)', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const, webOrigin: 'http://localhost:3000' };
  let h: Harness;
  let app: FastifyInstance;
  let url: string;

  beforeEach(async () => {
    // ~40 ms between mock events, so the run is still streaming when the client drops.
    h = makeHarness({ adapters: [new MockEngine({ tickMs: 40 })] });
    const live = new LiveHub({ bus: h.bus, runs: h.repos.runs, log: silent });
    app = await buildServer(config, { repos: h.repos, runs: h.service, live });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    url = `${address.replace('http', 'ws')}/ws`;
  });
  afterEach(async () => {
    await app.close();
    await h.service.shutdown();
    h.close();
  });

  it('disconnect mid-run, reconnect with afterSeq: the transcript is complete and ordered', async () => {
    const botId = h.bot('Echo');
    const threadId = h.dm(botId);
    const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: '[mock:tools]' });

    const first = await connect(url);
    first.send({ type: 'subscribe', channel: `run:${run.id}`, afterSeq: 0 });
    await first.until((f) => runEvents(f).length >= 4);
    await first.close();
    const seen = runEvents(first.frames);
    const lastSeq = seen.at(-1)!.seq;
    expect(seen.some((e) => e.event.type === 'run.finished')).toBe(false); // really dropped mid-run

    // Events keep being written while nobody listens.
    await new Promise((r) => setTimeout(r, 150));

    const second = await connect(url);
    second.send({ type: 'subscribe', channel: `run:${run.id}`, afterSeq: lastSeq });
    await second.until((f) => runEvents(f).some((e) => e.event.type === 'run.finished'));
    await h.service.idle();

    const all = [...seen, ...runEvents(second.frames)];
    const n = h.repos.runs.listEvents(run.id).length;
    expect(n).toBeGreaterThan(seen.length + 5);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    expect(all.map((e) => e.event)).toEqual(h.repos.runs.listEvents(run.id).map((r) => r.payload));
    expect(all.at(-1)!.event).toEqual({
      type: 'run.finished',
      status: 'succeeded',
      sessionId: expect.any(String),
    });

    // The text the UI would render equals the bot's stored reply.
    const finals = all.flatMap((e) => (e.event.type === 'text.final' ? [e.event.text.trim()] : []));
    const reply = h.repos.messages.getByRun(run.id);
    expect(finals.join('\n\n')).toBe(reply?.contentMd);
    await second.close();
  });

  it('streams run, thread and bot channels on one socket', async () => {
    const botId = h.bot('Echo');
    const threadId = h.dm(botId);
    const c = await connect(url, { origin: 'http://127.0.0.1:3000' });
    c.send({ type: 'subscribe', channel: `thread:${threadId}` });
    c.send({ type: 'subscribe', channel: `bot:${botId}` });
    await c.until((f) => f.filter((m) => m.type === 'subscribed').length === 2);

    const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: '[mock:hello]' });
    await h.service.idle();
    await c.until((f) =>
      f.some(
        (m) =>
          m.type === 'event' &&
          m.channel === `bot:${botId}` &&
          'status' in m.event &&
          m.event.status === 'succeeded',
      ),
    );
    const on = (ch: string) =>
      c.frames.flatMap((m) => (m.type === 'event' && m.channel === ch ? [m.event.type] : []));
    expect(on(`thread:${threadId}`)).toEqual(expect.arrayContaining(['run.updated', 'message.created']));
    expect(on(`bot:${botId}`)).toContain('run.updated');
    expect(c.frames.some((m) => m.type === 'event' && m.channel === `run:${run.id}`)).toBe(false);
    await c.close();
  });

  it('refuses upgrades from foreign origins', async () => {
    await expect(connect(url, { origin: 'https://evil.example' })).rejects.toThrow();
  });

  it('serves engine queue state', async () => {
    h.repos.engineState.upsert('claude', { limitedUntil: '2999-01-01T00:00:00.000Z' });
    h.repos.engineState.upsert('codex', { limitedUntil: '2000-01-01T00:00:00.000Z' });
    const res = await app.inject({ url: '/api/engines/state' });
    expect(res.json()).toEqual({
      override: null,
      engines: [
        { engine: 'claude', limitedUntil: '2999-01-01T00:00:00.000Z' },
        { engine: 'codex', limitedUntil: null },
        { engine: 'mock', limitedUntil: null },
      ],
    });
  });
});
