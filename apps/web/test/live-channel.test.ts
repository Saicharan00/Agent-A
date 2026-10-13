import type { LiveEvent } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  defaultLiveUrl,
  LiveConnection,
  type LiveStatus,
  type WsFactory,
} from '@/lib/live-channel';

class FakeSocket {
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

const runEvent = (runId: string, seq: number): LiveEvent => ({
  type: 'run.event',
  runId,
  seq,
  event: { type: 'text.delta', text: String(seq) },
  createdAt: '2026-10-13T10:00:00.000Z',
});

function harness(opts: { staleMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const statuses: LiveStatus[] = [];
  const tapped: { channel: string; event: LiveEvent }[] = [];
  let reconnects = 0;
  const createSocket: WsFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const conn = new LiveConnection({
    url: 'ws://x/ws',
    createSocket,
    staleMs: opts.staleMs ?? 50_000,
    onStatus: (s) => statuses.push(s),
    onEvent: (channel, event) => tapped.push({ channel, event }),
    onReconnect: () => reconnects++,
    random: () => 0.5, // no jitter
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => void ((t as { cleared: boolean }).cleared = true),
  });
  const last = () => sockets.at(-1)!;
  /** Reconnect timers (not the stale watchdog), oldest first. */
  const backoffs = () => timers.filter((t) => t.ms !== (opts.staleMs ?? 50_000));
  return { conn, sockets, last, timers, backoffs, statuses, tapped, reconnects: () => reconnects };
}

describe('backoffDelay', () => {
  it('doubles from the base, caps, and jitters ±25%', () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, 500, 15_000, mid))).toEqual([500, 1000, 2000, 4000]);
    expect(backoffDelay(10, 500, 15_000, mid)).toBe(15_000);
    expect(backoffDelay(0, 1000, 15_000, () => 0)).toBe(750);
    expect(backoffDelay(0, 1000, 15_000, () => 1)).toBe(1250);
  });
});

describe('defaultLiveUrl', () => {
  it('matches the page scheme', () => {
    expect(defaultLiveUrl({ protocol: 'http:', host: 'localhost:3000' })).toBe('ws://localhost:3000/ws');
    expect(defaultLiveUrl({ protocol: 'https:', host: 'a.b' })).toBe('wss://a.b/ws');
  });
});

describe('LiveConnection', () => {
  it('multiplexes channels on one socket and subscribes once per channel', () => {
    const h = harness();
    const a: LiveEvent[] = [];
    const b: LiveEvent[] = [];
    h.conn.subscribe('global', (e) => a.push(e));
    h.conn.subscribe('global', (e) => b.push(e));
    h.conn.subscribe('bot:b1', () => undefined);
    h.conn.start();
    h.last().open();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().sent).toEqual([
      { type: 'subscribe', channel: 'global' },
      { type: 'subscribe', channel: 'bot:b1' },
    ]);

    const ev: LiveEvent = { type: 'engine.state', engine: 'mock', limitedUntil: null };
    h.last().receive({ type: 'event', channel: 'global', event: ev });
    h.last().receive({ type: 'event', channel: 'thread:other', event: ev });
    h.last().receive('not json');
    h.last().receive({ type: 'ping', at: 'x' });
    expect(a).toEqual([ev]);
    expect(b).toEqual([ev]);
    expect(h.tapped).toEqual([{ channel: 'global', event: ev }]);
    expect(h.statuses).toEqual(['connecting', 'open']);
  });

  it('subscribes late channels at once and unsubscribes after the last listener leaves', () => {
    const h = harness();
    h.conn.start();
    h.last().open();
    const off1 = h.conn.subscribe('thread:t1', () => undefined);
    const off2 = h.conn.subscribe('thread:t1', () => undefined);
    off1();
    off1(); // idempotent
    expect(h.last().sent).toEqual([{ type: 'subscribe', channel: 'thread:t1' }]);
    off2();
    expect(h.last().sent.at(-1)).toEqual({ type: 'unsubscribe', channel: 'thread:t1' });
    expect(h.conn.channels).toEqual([]);
  });

  it('resubscribes run channels after a reconnect from the last seq, and drops repeats', () => {
    const h = harness();
    const got: number[] = [];
    h.conn.subscribe('run:r1', (e) => e.type === 'run.event' && got.push(e.seq));
    h.conn.start();
    h.last().open();
    expect(h.last().sent).toEqual([{ type: 'subscribe', channel: 'run:r1', afterSeq: 0 }]);
    for (const seq of [1, 2, 3])
      h.last().receive({ type: 'event', channel: 'run:r1', event: runEvent('r1', seq) });

    h.last().drop();
    expect(h.statuses.at(-1)).toBe('reconnecting');
    h.backoffs().at(-1)!.fn();
    h.last().open();
    expect(h.last().sent).toEqual([{ type: 'subscribe', channel: 'run:r1', afterSeq: 3 }]);
    expect(h.reconnects()).toBe(1);
    // A server that replays one too many must not show it twice.
    for (const seq of [3, 4, 5])
      h.last().receive({ type: 'event', channel: 'run:r1', event: runEvent('r1', seq) });
    expect(got).toEqual([1, 2, 3, 4, 5]);
  });

  it('honours an initial afterSeq (events already fetched over REST)', () => {
    const h = harness();
    h.conn.subscribe('run:r9', () => undefined, { afterSeq: 7 });
    h.conn.start();
    h.last().open();
    expect(h.last().sent).toEqual([{ type: 'subscribe', channel: 'run:r9', afterSeq: 7 }]);
  });

  it('reconnects with growing delays and resets after a successful open', () => {
    const h = harness();
    h.conn.start();
    h.last().drop();
    expect(h.backoffs().map((t) => t.ms)).toEqual([500]);
    h.backoffs()[0]!.fn();
    h.last().drop();
    expect(h.backoffs().map((t) => t.ms)).toEqual([500, 1000]);
    h.backoffs()[1]!.fn();
    h.last().open();
    h.last().drop();
    expect(h.backoffs().at(-1)!.ms).toBe(500);
    expect(h.statuses).toEqual(['connecting', 'reconnecting', 'open', 'reconnecting']);
    expect(h.reconnects()).toBe(0); // only counted once a re-open succeeds
  });

  it('treats a silent connection as dead and reconnects', () => {
    const h = harness({ staleMs: 50_000 });
    h.conn.start();
    h.last().open();
    const watchdog = h.timers.filter((t) => t.ms === 50_000 && !t.cleared);
    expect(watchdog).toHaveLength(1);
    h.last().receive({ type: 'ping', at: 'x' }); // re-arms
    expect(watchdog[0]!.cleared).toBe(true);
    const current = h.timers.filter((t) => t.ms === 50_000 && !t.cleared);
    current[0]!.fn();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.statuses.at(-1)).toBe('reconnecting');
    h.backoffs().at(-1)!.fn();
    expect(h.sockets).toHaveLength(2);
  });

  it('stops cleanly without reconnecting, and can start again', () => {
    const h = harness();
    h.conn.start();
    h.last().open();
    h.conn.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.backoffs()).toHaveLength(0);
    expect(h.conn.currentStatus).toBe('closed');
    h.conn.start();
    expect(h.sockets).toHaveLength(2);
  });

  it('closes a still-connecting socket only once it opens (no browser warning)', () => {
    const h = harness();
    h.conn.start();
    h.conn.stop();
    expect(h.sockets[0]!.closed).toBe(false);
    h.sockets[0]!.open();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sockets[0]!.sent).toEqual([]);
  });

  it('retries when the socket constructor throws', () => {
    const timers: number[] = [];
    const conn = new LiveConnection({
      url: 'ws://x',
      createSocket: () => {
        throw new Error('bad url');
      },
      random: () => 0.5,
      setTimer: (_fn, ms) => timers.push(ms),
    });
    conn.start();
    expect(timers).toEqual([500]);
    expect(conn.currentStatus).toBe('reconnecting');
  });
});
