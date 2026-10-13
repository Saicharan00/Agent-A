import type { LiveServerMessage } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/bus';
import { DockerMonitor } from '../../src/live/docker-monitor';
import { LiveHub, type LiveSocket } from '../../src/live/hub';
import { allowedOrigins } from '../../src/live/routes';
import { type Harness, makeHarness, silent } from '../runs/helpers';

class FakeSocket implements LiveSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: LiveServerMessage[] = [];
  pings = 0;
  terminated = false;
  closed: number | undefined;
  private readonly handlers = new Map<string, ((...a: unknown[]) => void)[]>();

  send(data: string) {
    this.sent.push(JSON.parse(data) as LiveServerMessage);
  }
  ping() {
    this.pings++;
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
  }
  close(code?: number) {
    this.closed = code;
    this.readyState = 3;
  }
  on(event: string, listener: (...a: never[]) => void) {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as (...a: unknown[]) => void);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const l of this.handlers.get(event) ?? []) l(...args);
  }
  client(msg: unknown) {
    this.emit('message', Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)), false);
  }
  /** Event frames on a channel, in order. */
  events(channel: string) {
    return this.sent.flatMap((m) => (m.type === 'event' && m.channel === channel ? [m.event] : []));
  }
}

describe('LiveHub', () => {
  let h: Harness;
  let hub: LiveHub;

  beforeEach(() => {
    h = makeHarness();
    hub = new LiveHub({ bus: h.bus, runs: h.repos.runs, log: silent, heartbeatMs: 60_000 });
  });
  afterEach(() => {
    hub.close();
    h.close();
  });

  it('subscribes, delivers only subscribed channels, and unsubscribes', () => {
    const s = new FakeSocket();
    hub.handle(s);
    s.client({ type: 'subscribe', channel: 'global' });
    expect(s.sent).toEqual([{ type: 'subscribed', channel: 'global' }]);

    h.bus.publish('global', { type: 'engine.state', engine: 'claude', limitedUntil: null });
    h.bus.publish('bot:b1', { type: 'bot.status', botId: 'b1', status: 'running' });
    expect(s.events('global')).toEqual([{ type: 'engine.state', engine: 'claude', limitedUntil: null }]);
    expect(s.events('bot:b1')).toEqual([]);

    s.client({ type: 'unsubscribe', channel: 'global' });
    h.bus.publish('global', { type: 'engine.state', engine: 'codex', limitedUntil: null });
    expect(s.events('global')).toHaveLength(1);
    expect(s.sent.at(-1)).toEqual({ type: 'unsubscribed', channel: 'global' });
  });

  it('rejects malformed frames and unknown channels without closing', () => {
    const s = new FakeSocket();
    hub.handle(s);
    s.client('not json');
    s.client({ type: 'subscribe', channel: 'evil:1' });
    s.client({ type: 'subscribe', channel: 'run:../../etc' });
    expect(s.sent.map((m) => m.type)).toEqual(['error', 'error', 'error']);
    expect(s.sent[1]).toMatchObject({ code: 'invalid_message', message: expect.stringContaining('channel') });
    s.client({ type: 'ping' });
    expect(s.sent.at(-1)).toMatchObject({ type: 'pong' });
    expect(s.terminated).toBe(false);
  });

  it('replays a finished run from afterSeq, then reports its status', async () => {
    const botId = h.bot('Echo');
    const run = h.service.enqueue({ botId, threadId: h.dm(botId), trigger: 'user', prompt: '[mock:tools]' });
    await h.service.idle();
    const total = h.repos.runs.listEvents(run.id).length;
    expect(total).toBeGreaterThan(5);

    const s = new FakeSocket();
    hub.handle(s);
    s.client({ type: 'subscribe', channel: `run:${run.id}`, afterSeq: 3 });
    const replayed = s.events(`run:${run.id}`);
    expect(replayed.map((e) => (e.type === 'run.event' ? e.seq : -1))).toEqual(
      Array.from({ length: total - 3 }, (_, i) => i + 4),
    );
    expect(replayed.at(-1)).toMatchObject({ event: { type: 'run.finished', status: 'succeeded' } });
    expect(s.sent.at(-1)).toEqual({
      type: 'subscribed',
      channel: `run:${run.id}`,
      lastSeq: total,
      status: 'succeeded',
    });
  });

  it('de-duplicates live run events already sent by the replay', () => {
    const botId = h.bot('Echo');
    const run = h.repos.runs.create({ botId, trigger: 'user', engine: 'mock', prompt: 'x' });
    h.repos.runs.appendEvents(run.id, [{ type: 'text.delta', payload: { type: 'text.delta', text: 'a' } }]);
    const s = new FakeSocket();
    hub.handle(s);
    s.client({ type: 'subscribe', channel: `run:${run.id}` });
    const live = (seq: number) => ({
      type: 'run.event',
      runId: run.id,
      seq,
      event: { type: 'text.delta', text: String(seq) },
      createdAt: '',
    });
    h.bus.publish(`run:${run.id}`, live(1)); // already replayed
    h.bus.publish(`run:${run.id}`, live(2));
    h.bus.publish(`run:${run.id}`, live(2)); // duplicate
    h.bus.publish(`run:${run.id}`, { type: 'run.updated', runId: run.id, status: 'running' });
    const seqs = s.events(`run:${run.id}`).map((e) => (e.type === 'run.event' ? e.seq : e.type));
    expect(seqs).toEqual([1, 2, 'run.updated']);
  });

  it('answers unknown runs with run_not_found and does not subscribe', () => {
    const s = new FakeSocket();
    hub.handle(s);
    s.client({ type: 'subscribe', channel: 'run:run_nope' });
    expect(s.sent).toEqual([
      { type: 'error', code: 'run_not_found', message: 'Run run_nope not found', channel: 'run:run_nope' },
    ]);
  });

  it('caps subscriptions per socket', () => {
    const small = new LiveHub({ bus: h.bus, log: silent, maxSubscriptions: 2, heartbeatMs: 60_000 });
    const s = new FakeSocket();
    small.handle(s);
    for (const c of ['bot:a', 'bot:b', 'bot:c']) s.client({ type: 'subscribe', channel: c });
    s.client({ type: 'subscribe', channel: 'bot:a' }); // re-subscribe is not a new one
    expect(s.sent.map((m) => m.type)).toEqual(['subscribed', 'subscribed', 'error', 'subscribed']);
    small.close();
  });

  it('drops listeners when the socket closes', () => {
    const bus = new EventBus();
    const spy = vi.spyOn(bus, 'subscribe');
    const local = new LiveHub({ bus, log: silent, heartbeatMs: 60_000 });
    const s = new FakeSocket();
    local.handle(s);
    s.client({ type: 'subscribe', channel: 'thread:t1' });
    expect(local.clientCount).toBe(1);
    s.emit('close');
    expect(local.clientCount).toBe(0);
    s.readyState = 1;
    bus.publish('thread:t1', { type: 'message.created' });
    expect(s.events('thread:t1')).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    local.close();
  });

  it('terminates slow consumers instead of buffering without bound', () => {
    const local = new LiveHub({ bus: h.bus, log: silent, maxBufferedBytes: 100, heartbeatMs: 60_000 });
    const s = new FakeSocket();
    local.handle(s);
    s.client({ type: 'subscribe', channel: 'global' });
    s.bufferedAmount = 1000;
    h.bus.publish('global', { type: 'engine.state', engine: 'mock', limitedUntil: null });
    expect(s.terminated).toBe(true);
    expect(local.clientCount).toBe(0);
    local.close();
  });

  describe('heartbeat', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('pings every period and terminates peers that stop answering', () => {
      const local = new LiveHub({ bus: new EventBus(), log: silent, heartbeatMs: 20_000 });
      const alive = new FakeSocket();
      const dead = new FakeSocket();
      local.handle(alive);
      local.handle(dead);

      vi.advanceTimersByTime(20_000);
      expect([alive.pings, dead.pings]).toEqual([1, 1]);
      expect(alive.sent.at(-1)).toMatchObject({ type: 'ping' });
      alive.emit('pong');

      vi.advanceTimersByTime(20_000);
      expect(dead.terminated).toBe(true);
      expect(alive.terminated).toBe(false);
      expect(alive.pings).toBe(2);
      expect(local.clientCount).toBe(1);
      local.close();
      expect(alive.closed).toBe(1001);
    });
  });
});

describe('DockerMonitor', () => {
  it('publishes docker.state on global only when it changes', async () => {
    const bus = new EventBus();
    const seen: unknown[] = [];
    bus.subscribe('global', (e) => seen.push(e));
    let health: { ok: boolean; version?: string; image?: boolean; error?: string } = {
      ok: true,
      version: '28.0',
      image: true,
    };
    const m = new DockerMonitor({ bus, health: async () => health });
    await m.check();
    await m.check();
    health = { ok: false, error: 'connect ENOENT' };
    await m.check();
    health = { ok: false, error: 'other wording' };
    await m.check();
    expect(seen).toEqual([
      { type: 'docker.state', ok: true, version: '28.0', image: true },
      { type: 'docker.state', ok: false, error: 'connect ENOENT' },
    ]);
  });
});

describe('allowedOrigins', () => {
  it('accepts the web origin and its loopback aliases on the same port', () => {
    const o = allowedOrigins('http://localhost:3000');
    expect([...o].sort()).toEqual(
      ['http://127.0.0.1:3000', 'http://[::1]:3000', 'http://localhost:3000'].sort(),
    );
    expect(o.has('http://localhost:3001')).toBe(false);
    expect(o.has('https://evil.example')).toBe(false);
  });
});
