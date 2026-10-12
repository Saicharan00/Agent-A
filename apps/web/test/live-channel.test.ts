import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  defaultLiveUrl,
  LiveChannelClient,
  type LiveStatus,
  type WsFactory,
} from '@/lib/live-channel';

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.onclose?.({});
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const statuses: LiveStatus[] = [];
  const messages: unknown[] = [];
  const createSocket: WsFactory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const client = new LiveChannelClient({
    url: 'ws://x/ws',
    channel: 'run:1',
    createSocket,
    onStatus: (s) => statuses.push(s),
    onMessage: (m) => messages.push(m.event),
    random: () => 0.5, // no jitter
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
  });
  return { client, sockets, timers, statuses, messages };
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

describe('LiveChannelClient', () => {
  it('subscribes on open and delivers only its channel', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.open();
    expect(h.sockets[0]!.sent).toEqual([JSON.stringify({ type: 'subscribe', channel: 'run:1' })]);
    h.sockets[0]!.receive({ channel: 'run:1', event: { type: 'text.delta', text: 'hi' } });
    h.sockets[0]!.receive({ channel: 'run:2', event: 'other' });
    h.sockets[0]!.receive('not json');
    expect(h.messages).toEqual([{ type: 'text.delta', text: 'hi' }]);
    expect(h.statuses).toEqual(['connecting', 'open']);
  });

  it('reconnects with growing delays and resets after a successful open', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.drop();
    expect(h.timers.map((t) => t.ms)).toEqual([500]);
    h.timers[0]!.fn();
    h.sockets[1]!.drop();
    expect(h.timers.map((t) => t.ms)).toEqual([500, 1000]);
    h.timers[1]!.fn();
    h.sockets[2]!.open();
    h.sockets[2]!.drop();
    expect(h.timers.at(-1)!.ms).toBe(500);
    expect(h.statuses).toEqual(['connecting', 'reconnecting', 'open', 'reconnecting']);
  });

  it('stops cleanly without reconnecting', () => {
    const h = harness();
    h.client.start();
    h.sockets[0]!.open();
    h.client.stop();
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.timers).toHaveLength(0);
    expect(h.client.currentStatus).toBe('closed');
  });

  it('retries when the socket constructor throws', () => {
    const timers: number[] = [];
    const client = new LiveChannelClient({
      url: 'ws://x',
      channel: 'global',
      onMessage: () => undefined,
      createSocket: () => {
        throw new Error('bad url');
      },
      random: () => 0.5,
      setTimer: (_fn, ms) => timers.push(ms),
    });
    client.start();
    expect(timers).toEqual([500]);
    expect(client.currentStatus).toBe('reconnecting');
  });
});
