import { Duplex } from 'node:stream';
import { type ComputerStatus, MAX_TERMINALS_PER_BOT, type TerminalServerMessage } from '@agenta/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { ContainerError } from '../../src/containers/manager';
import type { ExecOptions } from '../../src/containers/docker';
import { buildServer } from '../../src/server';
import { type TerminalHost, TerminalService } from '../../src/terminal/service';
import { silent } from '../runs/helpers';

type FakeTty = {
  opts: ExecOptions & { cols?: number; rows?: number };
  input: string[];
  sizes: [number, number][];
  stream: Duplex;
  /** Shell output. */
  out(text: string): void;
  /** The shell exits with `code`. */
  exit(code: number): void;
};

/** A stand-in for the container manager: TTY execs are in-memory duplex streams. */
class FakeHost implements TerminalHost {
  readonly ttys: FakeTty[] = [];
  readonly killed: string[] = [];
  readonly touched: string[] = [];
  status_: ComputerStatus['status'] = 'running';
  startError: Error | null = null;
  private exitCodes = new Map<Duplex, number>();

  async status(botId: string): Promise<ComputerStatus> {
    if (botId === 'bot_missing') throw new ContainerError('bot_not_found', `Bot ${botId} not found`, 404);
    return { botId, status: this.status_, containerId: 'c1', novncPort: null, health: null };
  }

  async execTty(_botId: string, opts: ExecOptions & { cols?: number; rows?: number }) {
    if (this.startError) throw this.startError;
    const input: string[] = [];
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        input.push(chunk.toString());
        cb();
      },
    });
    const tty: FakeTty = {
      opts,
      input,
      sizes: [],
      stream,
      out: (text) => stream.push(Buffer.from(text)),
      exit: (code) => {
        this.exitCodes.set(stream, code);
        stream.push(null);
      },
    };
    this.ttys.push(tty);
    return {
      stream,
      resize: async (cols: number, rows: number) => void tty.sizes.push([cols, rows]),
      wait: async () => this.exitCodes.get(stream) ?? -1,
    };
  }

  touch(botId: string): void {
    this.touched.push(botId);
  }

  async killTerminal(_botId: string, terminalId: string): Promise<void> {
    this.killed.push(terminalId);
  }
}

async function connect(url: string, headers?: Record<string, string>) {
  const control: TerminalServerMessage[] = [];
  let output = '';
  let closeCode: number | null = null;
  const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') control.push(JSON.parse(ev.data) as TerminalServerMessage);
    else output += Buffer.from(ev.data as ArrayBuffer).toString();
  };
  const closed = new Promise<void>((resolve) => {
    ws.onclose = (ev) => {
      closeCode = ev.code;
      resolve();
    };
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('socket error'));
  });
  return {
    ws,
    control,
    output: () => output,
    closed,
    closeCode: () => closeCode,
    send: (msg: unknown) => ws.send(JSON.stringify(msg)),
  };
}

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /ws/terminal/:botId', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const, webOrigin: 'http://localhost:3000' };
  let host: FakeHost;
  let terminals: TerminalService;
  let app: FastifyInstance;
  let base: string;

  beforeEach(async () => {
    host = new FakeHost();
    terminals = new TerminalService({ containers: host, log: silent, exitWaitMs: 200 });
    app = await buildServer(config, { terminals });
    base = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http', 'ws');
  });
  afterEach(async () => {
    await app.close();
  });

  it('opens a login shell as bot in /home/bot/work, streams output and forwards input', async () => {
    const c = await connect(`${base}/ws/terminal/bot_a?cols=120&rows=40`);
    await until(() => c.control.some((m) => m.type === 'ready'));
    const tty = host.ttys[0]!;
    expect(tty.opts).toMatchObject({
      cmd: ['bash', '-l'],
      workdir: '/home/bot/work',
      cols: 120,
      rows: 40,
      env: { TERM: 'xterm-256color', USER: 'bot', AGENTA_TERMINAL: expect.stringMatching(/^trm_/) },
    });
    expect(c.control).toEqual([{ type: 'ready', terminalId: tty.opts.env!.AGENTA_TERMINAL }]);

    tty.out('bot@agenta:~/work$ ');
    await until(() => c.output().includes('$ '));
    c.send({ type: 'input', data: 'echo hi\r' });
    await until(() => tty.input.join('') === 'echo hi\r');
    expect(host.touched).toContain('bot_a'); // typing counts as activity

    c.send({ type: 'resize', cols: 90, rows: 30 });
    await until(() => tty.sizes.length === 1);
    expect(tty.sizes).toEqual([[90, 30]]);
    c.ws.close();
    await c.closed;
  });

  it('closing the socket ends the shell and its processes', async () => {
    const c = await connect(`${base}/ws/terminal/bot_a`);
    await until(() => c.control.some((m) => m.type === 'ready'));
    expect(terminals.countFor('bot_a')).toBe(1);
    c.ws.close();
    await until(() => host.killed.length === 1);
    expect(host.killed).toEqual([host.ttys[0]!.opts.env!.AGENTA_TERMINAL]);
    expect(host.ttys[0]!.stream.destroyed).toBe(true);
    expect(terminals.countFor('bot_a')).toBe(0);
  });

  it('reports the exit code and closes when the shell exits', async () => {
    const c = await connect(`${base}/ws/terminal/bot_a`);
    await until(() => c.control.some((m) => m.type === 'ready'));
    host.ttys[0]!.exit(3);
    await c.closed;
    expect(c.control.at(-1)).toEqual({ type: 'exit', code: 3 });
    expect(c.closeCode()).toBe(1000);
  });

  it('each connection is a new shell', async () => {
    const a = await connect(`${base}/ws/terminal/bot_a`);
    const b = await connect(`${base}/ws/terminal/bot_a`);
    await until(() => host.ttys.length === 2 && b.control.some((m) => m.type === 'ready'));
    expect(host.ttys[0]!.opts.env!.AGENTA_TERMINAL).not.toBe(host.ttys[1]!.opts.env!.AGENTA_TERMINAL);
    expect(terminals.countFor('bot_a')).toBe(2);
    a.ws.close();
    b.ws.close();
    await Promise.all([a.closed, b.closed]);
  });

  it('says "starting" when the computer is not running yet', async () => {
    host.status_ = 'stopped';
    const c = await connect(`${base}/ws/terminal/bot_a`);
    await until(() => c.control.some((m) => m.type === 'ready'));
    expect(c.control.map((m) => m.type)).toEqual(['starting', 'ready']);
    c.ws.close();
  });

  it('rejects bad messages without closing', async () => {
    const c = await connect(`${base}/ws/terminal/bot_a`);
    await until(() => c.control.some((m) => m.type === 'ready'));
    c.ws.send('not json');
    c.send({ type: 'resize', cols: 0, rows: 10 });
    await until(() => c.control.filter((m) => m.type === 'error').length === 2);
    expect(c.control.filter((m) => m.type === 'error').map((m) => 'code' in m && m.code)).toEqual([
      'invalid_message',
      'invalid_message',
    ]);
    expect(host.ttys[0]!.sizes).toEqual([]);
    c.ws.close();
  });

  it('errors for an unknown bot or a failed start', async () => {
    const missing = await connect(`${base}/ws/terminal/bot_missing`);
    await missing.closed;
    expect(missing.control).toEqual([
      { type: 'error', code: 'bot_not_found', message: 'Bot bot_missing not found' },
    ]);

    host.startError = new ContainerError('image_missing', 'Image agenta-bot:latest not found', 503);
    const failed = await connect(`${base}/ws/terminal/bot_a`);
    await failed.closed;
    expect(failed.control).toEqual([
      { type: 'error', code: 'image_missing', message: 'Image agenta-bot:latest not found' },
    ]);
    expect(terminals.count).toBe(0);
  });

  it(`allows at most ${MAX_TERMINALS_PER_BOT} terminals per bot`, async () => {
    const open = [];
    for (let i = 0; i < MAX_TERMINALS_PER_BOT; i++) open.push(await connect(`${base}/ws/terminal/bot_a`));
    await until(() => host.ttys.length === MAX_TERMINALS_PER_BOT);
    const extra = await connect(`${base}/ws/terminal/bot_a`);
    await extra.closed;
    expect(extra.control[0]).toMatchObject({ type: 'error', code: 'too_many_terminals' });
    // Other bots are unaffected.
    const other = await connect(`${base}/ws/terminal/bot_b`);
    await until(() => other.control.some((m) => m.type === 'ready'));
    for (const c of [...open, other]) c.ws.close();
  });

  it('refuses foreign origins and bad sizes', async () => {
    await expect(connect(`${base}/ws/terminal/bot_a`, { origin: 'https://evil.example' })).rejects.toThrow();
    await expect(connect(`${base}/ws/terminal/bot_a?cols=0`)).rejects.toThrow();
    const ok = await connect(`${base}/ws/terminal/bot_a`, { origin: 'http://127.0.0.1:3000' });
    await until(() => ok.control.some((m) => m.type === 'ready'));
    expect(host.ttys[0]!.opts).toMatchObject({ cols: 80, rows: 24 });
    ok.ws.close();
  });

  it('runner shutdown closes open terminals', async () => {
    const c = await connect(`${base}/ws/terminal/bot_a`);
    await until(() => c.control.some((m) => m.type === 'ready'));
    await app.close();
    await c.closed;
    expect(host.killed).toHaveLength(1);
  });
});
