import type { RunsRepo } from '@agenta/db';
import {
  LIVE_HEARTBEAT_MS,
  type LiveEvent,
  type LiveRunEvent,
  type LiveServerMessage,
  type EngineEvent,
  liveClientMessageSchema,
  nowIso,
  runIdOfChannel,
} from '@agenta/shared';
import type { EventBus } from '../bus';

/** The slice of a `ws` WebSocket the hub uses (kept small so tests can pass a fake). */
export type LiveSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'pong' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
};

type Log = {
  debug(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
};

export type LiveHubOptions = {
  bus: EventBus;
  /** Needed for run-channel replay; without it `run:` subscriptions stream live events only. */
  runs?: Pick<RunsRepo, 'get' | 'listEvents'>;
  log: Log;
  heartbeatMs?: number;
  /** Per socket. */
  maxSubscriptions?: number;
  /** A client this far behind (bytes queued) is dropped; it reconnects and replays from the DB. */
  maxBufferedBytes?: number;
};

const OPEN = 1;
const REPLAY_PAGE = 1000;

type Client = {
  socket: LiveSocket;
  alive: boolean;
  subs: Map<string, () => void>;
};

/**
 * Fans event-bus channels out to WebSocket clients. Run channels replay persisted `run_events` after the client's
 * `afterSeq`, then stream live events, de-duplicated by seq. Subscribing to the bus and reading the DB happen in the
 * same synchronous block, and RunEventWriter publishes only after its insert committed, so no event can fall
 * between the replay and the live stream.
 */
export class LiveHub {
  private readonly clients = new Set<Client>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly maxSubscriptions: number;
  private readonly maxBufferedBytes: number;

  constructor(private readonly opts: LiveHubOptions) {
    this.maxSubscriptions = opts.maxSubscriptions ?? 256;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 8 * 1024 * 1024;
    this.heartbeat = setInterval(() => this.beat(), opts.heartbeatMs ?? LIVE_HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  handle(socket: LiveSocket): void {
    const client: Client = { socket, alive: true, subs: new Map() };
    this.clients.add(client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('message', (data, isBinary) => {
      client.alive = true;
      this.onMessage(client, data, isBinary);
    });
    socket.on('close', () => this.drop(client));
    socket.on('error', (err) => {
      this.opts.log.debug({ err: err.message }, 'live socket error');
      this.drop(client);
    });
  }

  /** Stops the heartbeat and closes every socket (runner shutdown). */
  close(): void {
    clearInterval(this.heartbeat);
    for (const c of [...this.clients]) {
      this.drop(c);
      c.socket.close(1001, 'runner stopping');
    }
  }

  private onMessage(client: Client, data: unknown, isBinary: boolean): void {
    let json: unknown;
    try {
      json = isBinary ? undefined : JSON.parse(String(data));
    } catch {
      json = undefined;
    }
    const parsed = liveClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.send(client, {
        type: 'error',
        code: 'invalid_message',
        message: `${issue?.path.join('.') || 'message'}: ${issue?.message ?? 'invalid'}`,
      });
      return;
    }
    const msg = parsed.data;
    if (msg.type === 'ping') this.send(client, { type: 'pong', at: nowIso() });
    else if (msg.type === 'unsubscribe') {
      client.subs.get(msg.channel)?.();
      client.subs.delete(msg.channel);
      this.send(client, { type: 'unsubscribed', channel: msg.channel });
    } else this.subscribe(client, msg.channel, msg.afterSeq ?? 0);
  }

  private subscribe(client: Client, channel: string, afterSeq: number): void {
    // Re-subscribing (e.g. with a new afterSeq) replaces the old subscription.
    client.subs.get(channel)?.();
    client.subs.delete(channel);
    if (client.subs.size >= this.maxSubscriptions) {
      this.send(client, {
        type: 'error',
        code: 'too_many_subscriptions',
        message: `At most ${this.maxSubscriptions} channels per connection`,
        channel,
      });
      return;
    }

    const runId = runIdOfChannel(channel);
    const run = runId && this.opts.runs ? this.opts.runs.get(runId) : undefined;
    if (runId && this.opts.runs && !run) {
      this.send(client, { type: 'error', code: 'run_not_found', message: `Run ${runId} not found`, channel });
      return;
    }

    let lastSeq = afterSeq;
    const unsubscribe = this.opts.bus.subscribe(channel, (raw) => {
      const event = raw as LiveEvent;
      if (runId && event.type === 'run.event') {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      this.send(client, { type: 'event', channel, event });
    });
    client.subs.set(channel, unsubscribe);

    if (!run || !this.opts.runs) {
      this.send(client, { type: 'subscribed', channel });
      return;
    }
    for (;;) {
      const page = this.opts.runs.listEvents(run.id, lastSeq, REPLAY_PAGE);
      for (const row of page) {
        const event: LiveRunEvent = {
          type: 'run.event',
          runId: run.id,
          seq: row.seq,
          event: row.payload as EngineEvent,
          createdAt: row.createdAt,
        };
        lastSeq = row.seq;
        this.send(client, { type: 'event', channel, event });
      }
      if (page.length < REPLAY_PAGE || !this.clients.has(client)) break;
    }
    // Status read after the replay: if it says finished, run.finished was among the replayed events.
    const status = this.opts.runs.get(run.id)?.status ?? run.status;
    this.send(client, { type: 'subscribed', channel, lastSeq, status });
  }

  private send(client: Client, msg: LiveServerMessage): void {
    const { socket } = client;
    if (socket.readyState !== OPEN || !this.clients.has(client)) return;
    if (socket.bufferedAmount > this.maxBufferedBytes) {
      this.opts.log.warn({ buffered: socket.bufferedAmount }, 'live client too slow; dropping it');
      this.drop(client);
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(msg));
  }

  private beat(): void {
    for (const c of [...this.clients]) {
      if (!c.alive) {
        // No pong (or any frame) since the last beat: the peer is gone.
        this.drop(c);
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.socket.ping();
      } catch {
        // Socket closing; its close event drops it.
      }
      this.send(c, { type: 'ping', at: nowIso() });
    }
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    for (const off of client.subs.values()) off();
    client.subs.clear();
  }
}
