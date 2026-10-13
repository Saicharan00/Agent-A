import { describe, expect, it } from 'vitest';
import {
  chunkInput,
  describeStatus,
  INPUT_CHUNK,
  TerminalConnection,
  type TerminalStatus,
  terminalUrl,
} from '@/lib/terminal';

class FakeSocket {
  readyState = 0;
  binaryType = 'blob';
  sent: unknown[] = [];
  closedWith: number | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close(code?: number) {
    this.closedWith = code ?? null;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  control(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  output(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const statuses: TerminalStatus[] = [];
  let output = '';
  const conn = new TerminalConnection({
    url: 'ws://x/ws/terminal/bot_a?cols=80&rows=24',
    onOutput: (d) => (output += new TextDecoder().decode(d)),
    onStatus: (s) => statuses.push(s),
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { conn, sockets, statuses, output: () => output };
}

describe('terminalUrl', () => {
  it('builds the proxied socket URL with the size', () => {
    expect(terminalUrl({ protocol: 'http:', host: 'localhost:3000' }, 'bot_a', { cols: 100, rows: 30 })).toBe(
      'ws://localhost:3000/ws/terminal/bot_a?cols=100&rows=30',
    );
    expect(terminalUrl({ protocol: 'https:', host: 'h' }, 'a/b', { cols: 80, rows: 24 })).toMatch(
      /^wss:\/\/h\/ws\/terminal\/a%2Fb\?/,
    );
  });
});

describe('chunkInput', () => {
  it('splits long pastes and keeps surrogate pairs whole', () => {
    expect(chunkInput('')).toEqual([]);
    expect(chunkInput('abc', 2)).toEqual(['ab', 'c']);
    expect(chunkInput('a😀b', 2)).toEqual(['a', '😀', 'b']);
    const big = 'x'.repeat(INPUT_CHUNK * 2 + 5);
    expect(chunkInput(big).map((c) => c.length)).toEqual([INPUT_CHUNK, INPUT_CHUNK, 5]);
  });
});

describe('TerminalConnection', () => {
  it('goes connecting → starting → open, streams output, sends input and resizes', () => {
    const h = harness();
    h.conn.connect();
    const ws = h.sockets[0]!;
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();
    h.conn.sendInput('ignored before ready');
    ws.control({ type: 'starting' });
    ws.control({ type: 'ready', terminalId: 'trm_1' });
    expect(h.statuses.map((s) => s.state)).toEqual(['connecting', 'starting', 'open']);

    ws.output('bot@x:~/work$ ');
    expect(h.output()).toBe('bot@x:~/work$ ');
    h.conn.sendInput('ls\r');
    h.conn.resize(120, 40);
    h.conn.resize(0, 0); // hidden panel: ignored
    expect(ws.sent).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', cols: 120, rows: 40 },
    ]);
  });

  it('reports the exit code, and a drop afterwards is not a disconnect', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.control({ type: 'ready', terminalId: 'trm_1' });
    h.sockets[0]!.control({ type: 'exit', code: 0 });
    h.sockets[0]!.drop();
    expect(h.statuses.at(-1)).toEqual({ state: 'exited', detail: 'code 0' });
    expect(describeStatus(h.statuses.at(-1)!)).toBe('Shell exited (code 0)');
  });

  it('a dropped connection is "disconnected" and does not reconnect by itself', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.control({ type: 'ready', terminalId: 'trm_1' });
    h.sockets[0]!.drop();
    expect(h.conn.current.state).toBe('disconnected');
    expect(h.sockets).toHaveLength(1);
  });

  it('runner errors end the terminal, frame-level errors do not', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.sockets[0]!.control({ type: 'ready', terminalId: 'trm_1' });
    h.sockets[0]!.control({ type: 'error', code: 'invalid_message', message: 'bad' });
    expect(h.conn.current.state).toBe('open');
    h.sockets[0]!.control({ type: 'error', code: 'image_missing', message: 'Image missing' });
    expect(h.conn.current).toEqual({ state: 'error', detail: 'Image missing' });
  });

  it('close() closes the socket quietly', () => {
    const h = harness();
    h.conn.connect();
    h.sockets[0]!.open();
    h.conn.close();
    expect(h.sockets[0]!.closedWith).toBe(1000);
    expect(h.statuses.map((s) => s.state)).toEqual(['connecting']);
  });
});

describe('terminal tabs', () => {
  it('adds numbered tabs per bot up to the limit, closes and prunes', async () => {
    const { addTab, closeTab, MAX_TABS, pruneBots } = await import('@/lib/terminal-tabs');
    let t = addTab(addTab({}, 'bot_a'), 'bot_a');
    t = addTab(t, 'bot_b');
    expect(t.bot_a!.list.map((x) => x.title)).toEqual(['bash 1', 'bash 2']);
    expect(t.bot_a!.active).toBe('bot_a:2');

    // Closing the active tab activates its neighbour; numbers are not reused.
    t = closeTab(t, 'bot_a', 'bot_a:2');
    expect(t.bot_a!.active).toBe('bot_a:1');
    t = addTab(t, 'bot_a');
    expect(t.bot_a!.list.map((x) => x.title)).toEqual(['bash 1', 'bash 3']);
    t = closeTab(closeTab(t, 'bot_a', 'bot_a:1'), 'bot_a', 'bot_a:3');
    expect(t.bot_a).toEqual({ list: [], active: null, next: 4 });

    let full = {};
    for (let i = 0; i < MAX_TABS + 2; i++) full = addTab(full, 'bot_c');
    expect((full as typeof t).bot_c!.list).toHaveLength(MAX_TABS);

    expect(pruneBots(t, new Set(['bot_a', 'bot_b']))).toBe(t);
    expect(Object.keys(pruneBots(t, new Set(['bot_b'])))).toEqual(['bot_b']);
  });
});
