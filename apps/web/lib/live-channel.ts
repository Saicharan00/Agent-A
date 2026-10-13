// WebSocket client for the runner's live channels (`run:<id>`, `thread:<id>`, `bot:<id>`, `global`).
// One connection per tab multiplexes every subscription (wire protocol: packages/shared/src/live.ts). It reconnects
// with capped exponential backoff + jitter, re-subscribes everything, and asks run channels to replay from the
// last seq it delivered, so a dropped connection never loses or repeats run events.
import { LIVE_HEARTBEAT_MS, type LiveEvent, type LiveServerMessage, runIdOfChannel } from '@agenta/shared';

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export type LiveListener = (event: LiveEvent) => void;

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

export type LiveConnectionOptions = {
  url: string;
  /** Every event on every channel, before channel listeners (TanStack Query cache updates). */
  onEvent?: (channel: string, event: LiveEvent) => void;
  onStatus?: (status: LiveStatus) => void;
  /** After a re-open (not the first): refetch what non-replayable channels may have missed. */
  onReconnect?: () => void;
  createSocket?: WsFactory;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** No frame (the server pings every 20 s) for this long → the connection is treated as dead. */
  staleMs?: number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

const CONNECTING = 0;
const OPEN = 1;

/** Delay before reconnect attempt `attempt` (0-based): base·2^attempt, capped, with ±25% jitter. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 15_000, random = Math.random): number {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(raw * (0.75 + random() * 0.5));
}

/** ws(s)://<host>/ws on the current origin; Next rewrites /ws to the runner like /api (next.config.ts). */
export function defaultLiveUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

export class LiveConnection {
  private socket: WsLike | null = null;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private staleTimer: unknown = null;
  private stopped = true;
  private openedBefore = false;
  private status: LiveStatus = 'idle';
  private readonly listeners = new Map<string, Set<LiveListener>>();
  /** Highest seq delivered per run channel: the `afterSeq` of the next (re)subscribe. */
  private readonly lastSeq = new Map<string, number>();
  private readonly statusListeners = new Set<(s: LiveStatus) => void>();

  constructor(private readonly opts: LiveConnectionOptions) {}

  get currentStatus(): LiveStatus {
    return this.status;
  }

  /** Channels with at least one listener. */
  get channels(): string[] {
    return [...this.listeners.keys()];
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer('reconnectTimer');
    this.clearTimer('staleTimer');
    this.dropSocket();
    this.setStatus('closed');
  }

  /**
   * Listens on a channel; the first listener subscribes on the server. For a run channel the server replays
   * persisted events after `afterSeq` (default 0, i.e. the whole run) to the connection. Returns an unsubscribe.
   */
  subscribe(channel: string, listener: LiveListener, opts: { afterSeq?: number } = {}): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      if (runIdOfChannel(channel)) this.lastSeq.set(channel, opts.afterSeq ?? 0);
      this.sendSubscribe(channel);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      if (!current?.delete(listener) || current.size > 0) return;
      this.listeners.delete(channel);
      this.lastSeq.delete(channel);
      this.send({ type: 'unsubscribe', channel });
    };
  }

  onStatus(listener: (s: LiveStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: LiveStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
    for (const l of this.statusListeners) l(s);
  }

  private send(msg: object): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private sendSubscribe(channel: string): void {
    const afterSeq = this.lastSeq.get(channel);
    this.send(
      afterSeq === undefined ? { type: 'subscribe', channel } : { type: 'subscribe', channel, afterSeq },
    );
  }

  private connect(): void {
    this.setStatus(this.openedBefore || this.attempt > 0 ? 'reconnecting' : 'connecting');
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
      this.armStale();
      for (const channel of this.listeners.keys()) this.sendSubscribe(channel);
      const reconnected = this.openedBefore;
      this.openedBefore = true;
      this.setStatus('open');
      if (reconnected) this.opts.onReconnect?.();
    };
    socket.onmessage = (ev) => {
      this.armStale();
      if (typeof ev.data !== 'string') return;
      let msg: LiveServerMessage;
      try {
        msg = JSON.parse(ev.data) as LiveServerMessage;
      } catch {
        return; // Ignore malformed frames.
      }
      if (msg?.type === 'event') this.deliver(msg.channel, msg.event);
    };
    socket.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimer('staleTimer');
      this.scheduleReconnect();
    };
  }

  private deliver(channel: string, event: LiveEvent): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    if (event.type === 'run.event' && this.lastSeq.has(channel)) {
      if (event.seq <= this.lastSeq.get(channel)!) return; // already delivered before a reconnect
      this.lastSeq.set(channel, event.seq);
    }
    this.opts.onEvent?.(channel, event);
    for (const l of [...set]) l(event);
  }

  /** (Re)starts the dead-connection watchdog; any frame from the server proves it alive. */
  private armStale(): void {
    this.clearTimer('staleTimer');
    const ms = this.opts.staleMs ?? Math.round(LIVE_HEARTBEAT_MS * 2.5);
    this.staleTimer = (this.opts.setTimer ?? setTimeout)(() => {
      this.staleTimer = null;
      this.dropSocket();
      this.scheduleReconnect();
    }, ms);
  }

  private dropSocket(): void {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.onclose = null;
    s.onmessage = null;
    s.onerror = null;
    // Closing a socket that is still connecting makes the browser log a warning (React StrictMode mounts,
    // unmounts and remounts in dev), so let it finish connecting and close it then.
    if (s.readyState === CONNECTING) s.onopen = () => s.close();
    else {
      s.onopen = null;
      s.close();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    const delay = backoffDelay(this.attempt++, this.opts.baseDelayMs, this.opts.maxDelayMs, this.opts.random);
    this.reconnectTimer = (this.opts.setTimer ?? setTimeout)(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private clearTimer(which: 'reconnectTimer' | 'staleTimer'): void {
    if (this[which] !== null) (this.opts.clearTimer ?? clearTimeout)(this[which] as never);
    this[which] = null;
  }
}
