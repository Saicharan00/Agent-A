// Client for the runner's terminal socket (F14, protocol in packages/shared/src/terminal.ts). One connection is one
// shell: there is no automatic reconnect, because a new connection would silently be a different shell. The UI
// offers "New shell" instead.
import { type TerminalClientMessage, terminalServerMessageSchema } from '@agenta/shared';

export type TerminalState =
  /** Socket opening, or the shell is being attached. */
  | 'connecting'
  /** The bot's computer is being started for this terminal (can take a while on first use). */
  | 'starting'
  | 'open'
  /** The shell ended (`exit`, Ctrl-D, the computer stopped). */
  | 'exited'
  /** The connection dropped (runner restart, network). */
  | 'disconnected'
  /** The runner refused or could not open the terminal. */
  | 'error';

export type TerminalStatus = { state: TerminalState; detail?: string };

type WsLike = {
  readyState: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number): void;
};
export type TerminalWsFactory = (url: string) => WsLike;

export type TerminalConnectionOptions = {
  url: string;
  onOutput: (data: Uint8Array) => void;
  onStatus: (status: TerminalStatus) => void;
  createSocket?: TerminalWsFactory;
};

/** Larger pastes are split so every frame stays under the runner's 64 KiB frame limit. */
export const INPUT_CHUNK = 16 * 1024;

const OPEN = 1;

/** ws(s)://<host>/ws/terminal/<botId>?cols=&rows= on the current origin (Next proxies it to the runner). */
export function terminalUrl(
  location: { protocol: string; host: string },
  botId: string,
  size: { cols: number; rows: number },
): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = new URLSearchParams({ cols: String(size.cols), rows: String(size.rows) });
  return `${proto}//${location.host}/ws/terminal/${encodeURIComponent(botId)}?${q}`;
}

/** Splits `data` into chunks of at most `max` UTF-16 units without cutting a surrogate pair. */
export function chunkInput(data: string, max = INPUT_CHUNK): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    let end = Math.min(i + max, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

export function describeStatus(s: TerminalStatus): string {
  switch (s.state) {
    case 'connecting':
      return 'Connecting…';
    case 'starting':
      return 'Starting the computer…';
    case 'open':
      return 'Connected';
    case 'exited':
      return s.detail ? `Shell exited (${s.detail})` : 'Shell exited';
    case 'disconnected':
      return 'Disconnected';
    case 'error':
      return s.detail ?? 'Terminal error';
  }
}

export class TerminalConnection {
  private socket: WsLike | null = null;
  private status: TerminalStatus = { state: 'connecting' };
  private done = false;

  constructor(private readonly opts: TerminalConnectionOptions) {}

  get current(): TerminalStatus {
    return this.status;
  }

  connect(): void {
    if (this.socket) return;
    const create = this.opts.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
    const ws = create(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;
    this.set({ state: 'connecting' });
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      this.socket = null;
      if (!this.done) this.finish({ state: 'disconnected' });
    };
    ws.onerror = () => undefined; // onclose follows
  }

  sendInput(data: string): void {
    if (this.status.state !== 'open') return;
    for (const part of chunkInput(data)) this.send({ type: 'input', data: part });
  }

  resize(cols: number, rows: number): void {
    if (cols < 2 || rows < 1) return;
    this.send({ type: 'resize', cols, rows });
  }

  /** Closes the socket; the runner then ends the shell. */
  close(): void {
    this.done = true;
    const ws = this.socket;
    this.socket = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close(1000);
    }
  }

  private send(msg: TerminalClientMessage): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') {
      if (data instanceof ArrayBuffer) this.opts.onOutput(new Uint8Array(data));
      else if (ArrayBuffer.isView(data))
        this.opts.onOutput(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = terminalServerMessageSchema.safeParse(json);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === 'starting') this.set({ state: 'starting' });
    else if (msg.type === 'ready') this.set({ state: 'open' });
    else if (msg.type === 'exit')
      this.finish({ state: 'exited', ...(msg.code !== null ? { detail: `code ${msg.code}` } : {}) });
    // invalid_message is about one frame; the shell is still there.
    else if (msg.code !== 'invalid_message') this.finish({ state: 'error', detail: msg.message });
  }

  private finish(s: TerminalStatus): void {
    if (this.done) return;
    this.done = true;
    this.set(s);
  }

  private set(s: TerminalStatus): void {
    this.status = s;
    this.opts.onStatus(s);
  }
}
