import { newId } from '@agenta/shared';
import { ContainerError, type ContainerManager } from '../containers/manager';
import type { TerminalSocket } from '../terminal/service';

type Log = {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
};

export type DesktopHost = Pick<ContainerManager, 'ensureRunning' | 'acquire' | 'touch'>;

/** The slice of a WebSocket client the proxy uses for the upstream (websockify) side. */
export type UpstreamSocket = {
  readonly readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: ArrayBuffer | Uint8Array): void;
  close(): void;
};

export type DesktopServiceOptions = {
  containers: DesktopHost;
  log: Log;
  /** Opens the upstream socket; defaults to Node's global WebSocket. */
  connect?: (url: string) => UpstreamSocket;
  /** websockify needs a moment after a fresh start: keep retrying the upstream for this long. */
  connectTimeoutMs?: number;
  retryDelayMs?: number;
};

const OPEN = 1;

/**
 * GET /ws/desktop/:botId: a byte-for-byte WebSocket bridge between the browser's noVNC client and the bot's
 * websockify (published to 127.0.0.1:<novnc_port> on the runner's machine), so the container's port is never
 * reached from the browser directly. The computer starts on demand and stays awake while a desktop is watched.
 * Failures close the socket with code 1011 and the error code as the reason (the RFB stream has no room for
 * control messages).
 */
export class DesktopService {
  private readonly sessions = new Map<string, () => void>();
  private readonly connect: (url: string) => UpstreamSocket;
  private readonly connectTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: DesktopServiceOptions) {
    this.connect = opts.connect ?? ((url) => new WebSocket(url) as unknown as UpstreamSocket);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 20_000;
    this.retryDelayMs = opts.retryDelayMs ?? 500;
  }

  get count(): number {
    return this.sessions.size;
  }

  async close(): Promise<void> {
    for (const dispose of [...this.sessions.values()]) dispose();
  }

  async handle(socket: TerminalSocket, botId: string): Promise<void> {
    const { containers, log } = this.opts;
    const id = newId('desktop');
    let closed = false;
    let upstream: UpstreamSocket | null = null;
    let release: (() => void) | null = null;
    const dispose = (code = 1000, reason = 'closed') => {
      if (!this.sessions.delete(id)) return;
      closed = true;
      release?.();
      if (upstream && upstream.readyState <= OPEN) upstream.close();
      if (socket.readyState === OPEN) socket.close(code, reason);
      log.info({ botId, desktopId: id, reason }, 'desktop closed');
    };
    this.sessions.set(id, () => dispose(1001, 'runner stopping'));

    // Client frames that arrive while the upstream is still connecting (the RFB handshake waits for the server
    // first, so this stays tiny).
    const pending: Buffer[] = [];
    socket.on('message', (data) => {
      const buf = data as Buffer;
      containers.touch(botId);
      if (upstream?.readyState === OPEN) upstream.send(buf);
      else if (pending.length < 64) pending.push(buf);
    });
    socket.on('close', () => dispose(1000, 'client closed'));
    socket.on('error', () => dispose(1000, 'socket error'));

    let port: number | null;
    try {
      port = (await containers.ensureRunning(botId)).hostPort;
    } catch (err) {
      const code = err instanceof ContainerError ? err.code : 'docker_unavailable';
      log.warn({ botId, err: (err as Error).message }, 'desktop could not start the computer');
      dispose(1011, code);
      return;
    }
    if (closed) return;
    if (!port) {
      dispose(1011, 'desktop_unavailable');
      return;
    }
    release = containers.acquire(botId);

    const url = `ws://127.0.0.1:${port}/websockify`;
    const deadline = Date.now() + this.connectTimeoutMs;
    const attempt = () => {
      if (closed) return;
      const up = this.connect(url);
      up.binaryType = 'arraybuffer';
      upstream = up;
      let opened = false;
      up.onopen = () => {
        opened = true;
        for (const buf of pending.splice(0)) up.send(buf);
        log.info({ botId, desktopId: id }, 'desktop opened');
      };
      up.onmessage = (ev) => {
        // shortcut: no backpressure towards a slow browser; x11vnc only sends updates the client asks for.
        if (socket.readyState === OPEN) socket.send(Buffer.from(ev.data as ArrayBuffer));
      };
      up.onerror = () => undefined; // onclose follows
      up.onclose = () => {
        if (closed) return;
        if (opened) dispose(1000, 'desktop ended');
        else if (Date.now() < deadline) setTimeout(attempt, this.retryDelayMs).unref();
        else dispose(1011, 'desktop_unavailable');
      };
    };
    attempt();
  }
}
