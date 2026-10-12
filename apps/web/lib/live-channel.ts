// WebSocket client skeleton for runner channels (`run:<id>`, `thread:<id>`, `bot:<id>`, `global`).
// Reconnects with capped exponential backoff + jitter. The wire protocol and the WS endpoint
// are finalised in F11; until then nothing mounts this against a live server.

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export type LiveMessage = { channel: string; event: unknown };

type WsLike = {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
};
export type WsFactory = (url: string) => WsLike;

export type LiveChannelOptions = {
  url: string;
  channel: string;
  onMessage: (msg: LiveMessage) => void;
  onStatus?: (status: LiveStatus) => void;
  createSocket?: WsFactory;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** Delay before reconnect attempt `attempt` (0-based): base·2^attempt, capped, with ±25% jitter. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 15_000, random = Math.random): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(raw * (0.75 + random() * 0.5));
}

/** ws(s)://<host>/ws on the current origin. F11 decides how /ws reaches the runner. */
export function defaultLiveUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

export class LiveChannelClient {
  private socket: WsLike | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;
  private status: LiveStatus = 'idle';

  constructor(private readonly opts: LiveChannelOptions) {}

  get currentStatus(): LiveStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.opts.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.setStatus('closed');
  }

  private setStatus(s: LiveStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  private connect(): void {
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const create = this.opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
    let socket: WsLike;
    try {
      socket = create(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      socket.send(JSON.stringify({ type: 'subscribe', channel: this.opts.channel }));
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data) as Partial<LiveMessage>;
        if (msg && msg.channel === this.opts.channel)
          this.opts.onMessage({ channel: msg.channel, event: msg.event });
      } catch {
        // Ignore malformed frames.
      }
    };
    socket.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
    socket.onclose = () => {
      this.socket = null;
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    const delay = backoffDelay(this.attempt++, this.opts.baseDelayMs, this.opts.maxDelayMs, this.opts.random);
    this.timer = (this.opts.setTimer ?? setTimeout)(() => {
      this.timer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}
