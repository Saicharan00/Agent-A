import { PassThrough } from 'node:stream';
import type { ComputerStatus } from '@agenta/shared';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { EventBus } from '../../src/bus';
import type { ContainerInfo, ExecHandle, ExecOptions } from '../../src/containers/docker';
import { ContainerError } from '../../src/containers/manager';
import { type DesktopHost, DesktopService } from '../../src/desktop/service';
import { buildServer } from '../../src/server';
import { silent } from '../runs/helpers';

/** Stands in for the container manager: the "computer" publishes noVNC on `port`. */
class FakeHost implements DesktopHost {
  port: number | null = null;
  startError: Error | null = null;
  leases = 0;
  readonly touched: string[] = [];

  async ensureRunning(_botId: string): Promise<ContainerInfo> {
    if (this.startError) throw this.startError;
    return { id: 'c1', state: 'running', hostPort: this.port } as ContainerInfo;
  }

  acquire(_botId: string): () => void {
    this.leases++;
    let done = false;
    return () => {
      if (!done) this.leases--;
      done = true;
    };
  }

  touch(botId: string): void {
    this.touched.push(botId);
  }

  status_: ComputerStatus['status'] = 'running';
  execs: ExecOptions[] = [];
  execExit = 0;

  async status(botId: string): Promise<ComputerStatus> {
    return { botId, status: this.status_, containerId: 'c1', novncPort: this.port, health: null };
  }

  async exec(_botId: string, opts: ExecOptions): Promise<ExecHandle> {
    this.execs.push(opts);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.end();
    stderr.end(this.execExit ? 'import: unable to open X server' : '');
    return { stdout, stderr, wait: async () => this.execExit };
  }
}

/** A websockify stand-in: greets with an RFB version banner and echoes everything back reversed. */
async function fakeWebsockify(port = 0): Promise<{ app: FastifyInstance; port: number; paths: string[] }> {
  const app = Fastify();
  const paths: string[] = [];
  await app.register(websocket);
  app.get('/*', { websocket: true }, (socket, req) => {
    paths.push(req.url);
    socket.send(Buffer.from('RFB 003.008\n'));
    socket.on('message', (data: Buffer) => socket.send(Buffer.from(data).reverse()));
  });
  const url = await app.listen({ host: '127.0.0.1', port });
  return { app, port: Number(new URL(url).port), paths };
}

async function connect(url: string, headers?: Record<string, string>) {
  const received: string[] = [];
  let close: { code: number; reason: string } | null = null;
  const ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (ev) => received.push(Buffer.from(ev.data as ArrayBuffer).toString());
  const closed = new Promise<void>((resolve) => {
    ws.onclose = (ev) => {
      close = { code: ev.code, reason: ev.reason };
      resolve();
    };
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('socket error'));
  });
  return { ws, received, closed, close: () => close };
}

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('GET /ws/desktop/:botId', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const, webOrigin: 'http://localhost:3000' };
  let host: FakeHost;
  let desktops: DesktopService;
  let app: FastifyInstance;
  let base: string;
  const upstreams: FastifyInstance[] = [];

  beforeEach(async () => {
    host = new FakeHost();
    desktops = new DesktopService({
      containers: host,
      log: silent,
      connectTimeoutMs: 1500,
      retryDelayMs: 50,
    });
    app = await buildServer(config, { desktops });
    base = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http', 'ws');
  });
  afterEach(async () => {
    await app.close();
    for (const u of upstreams.splice(0)) await u.close();
  });

  it('bridges bytes both ways to the published websockify port and holds a lease while open', async () => {
    const up = await fakeWebsockify();
    upstreams.push(up.app);
    host.port = up.port;
    const c = await connect(`${base}/ws/desktop/bot_a`);
    await until(() => c.received.includes('RFB 003.008\n'));
    expect(up.paths).toEqual(['/websockify']);
    expect(host.leases).toBe(1);

    c.ws.send(new TextEncoder().encode('abc'));
    await until(() => c.received.includes('cba'));
    expect(host.touched).toContain('bot_a'); // input counts as activity

    c.ws.close();
    await c.closed;
    await until(() => host.leases === 0 && desktops.count === 0);
  });

  it('keeps retrying while websockify comes up after a fresh start', async () => {
    const probe = await fakeWebsockify();
    const port = probe.port;
    await probe.app.close(); // nothing listens yet
    host.port = port;
    const c = await connect(`${base}/ws/desktop/bot_a`);
    await new Promise((r) => setTimeout(r, 200));
    const up = await fakeWebsockify(port);
    upstreams.push(up.app);
    await until(() => c.received.includes('RFB 003.008\n'));
    c.ws.close();
  });

  it('closes with 1011 and a reason when the desktop cannot be reached', async () => {
    host.startError = new ContainerError('bot_not_found', 'Bot bot_x not found', 404);
    const a = await connect(`${base}/ws/desktop/bot_x`);
    await a.closed;
    expect(a.close()).toEqual({ code: 1011, reason: 'bot_not_found' });

    host.startError = null;
    host.port = null;
    const b = await connect(`${base}/ws/desktop/bot_a`);
    await b.closed;
    expect(b.close()).toEqual({ code: 1011, reason: 'desktop_unavailable' });

    const probe = await fakeWebsockify();
    await probe.app.close();
    host.port = probe.port; // never comes up
    const c = await connect(`${base}/ws/desktop/bot_a`);
    await c.closed;
    expect(c.close()).toEqual({ code: 1011, reason: 'desktop_unavailable' });
    expect(host.leases).toBe(0);
  });

  it('ends when the desktop goes away', async () => {
    const up = await fakeWebsockify();
    host.port = up.port;
    const c = await connect(`${base}/ws/desktop/bot_a`);
    await until(() => c.received.length > 0);
    await up.app.close();
    await c.closed;
    expect(host.leases).toBe(0);
  });

  it('refuses foreign origins', async () => {
    await expect(connect(`${base}/ws/desktop/bot_a`, { origin: 'https://evil.example' })).rejects.toThrow();
  });

  it('runner shutdown closes open desktops', async () => {
    const up = await fakeWebsockify();
    upstreams.push(up.app);
    host.port = up.port;
    const c = await connect(`${base}/ws/desktop/bot_a`);
    await until(() => c.received.length > 0);
    await app.close();
    await c.closed;
    expect(host.leases).toBe(0);
  });
});

describe('POST /api/bots/:id/computer/screenshot', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };

  it('saves the screen into ~/screenshots and tells the Files tab', async () => {
    const host = new FakeHost();
    const bus = new EventBus();
    const events: unknown[] = [];
    bus.subscribe('bot:bot_a', (e) => events.push(e));
    const app = await buildServer(config, {
      desktops: new DesktopService({ containers: host, bus, log: silent }),
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/bots/bot_a/computer/screenshot' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { root: string; path: string };
      expect(body.root).toBe('home');
      expect(body.path).toMatch(/^screenshots\/desktop-\d{4}-\d\d-\d\dT[\d-]+Z\.png$/);
      expect(host.execs[0]!.cmd).toEqual([
        'sh',
        '-c',
        'mkdir -p "$(dirname "$0")" && import -display :99 -window root "$0"',
        body.path,
      ]);
      expect(events).toEqual([
        { type: 'files.changed', botId: 'bot_a', root: 'home', path: body.path, change: 'created' },
      ]);

      host.execExit = 1;
      const failed = await app.inject({ method: 'POST', url: '/api/bots/bot_a/computer/screenshot' });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toMatchObject({ error: { code: 'screenshot_failed' } });

      host.status_ = 'stopped';
      const stopped = await app.inject({ method: 'POST', url: '/api/bots/bot_a/computer/screenshot' });
      expect(stopped.statusCode).toBe(409);
      expect(stopped.json()).toMatchObject({ error: { code: 'computer_stopped' } });
    } finally {
      await app.close();
    }
  });
});
