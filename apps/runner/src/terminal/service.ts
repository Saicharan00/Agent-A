import {
  LIVE_HEARTBEAT_MS,
  MAX_TERMINALS_PER_BOT,
  TERMINAL_CWD,
  type TerminalServerMessage,
  newId,
  terminalClientMessageSchema,
} from '@agenta/shared';
import { ContainerError, type ContainerManager } from '../containers/manager';

/** The slice of a `ws` WebSocket a terminal uses (small, so tests can pass a fake). */
export type TerminalSocket = {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  ping(): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown;
  on(event: 'pong' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
};

type Log = {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
};

export type TerminalHost = Pick<ContainerManager, 'status' | 'execTty' | 'touch' | 'killTerminal'>;

export type TerminalServiceOptions = {
  containers: TerminalHost;
  log: Log;
  heartbeatMs?: number;
  /** Output is paused while this many bytes wait in the socket's send buffer (a slow client). */
  highWaterBytes?: number;
  /** How long to wait for the exit code after the shell's stream ended. */
  exitWaitMs?: number;
};

const OPEN = 1;

type Session = { id: string; botId: string; dispose: (reason: string) => void };

/**
 * GET /ws/terminal/:botId: one connection = one fresh `bash -l` (user `bot`, cwd /home/bot/work) in the bot's
 * computer, started on demand. Output streams as binary frames; input/resize arrive as JSON text frames
 * (packages/shared/src/terminal.ts). Closing the socket ends the shell and everything it started; while attached,
 * the terminal holds a lease on the computer (no idle auto-stop) and every keystroke counts as activity.
 */
export class TerminalService {
  private readonly sessions = new Map<string, Session>();
  private readonly heartbeatMs: number;
  private readonly highWater: number;

  constructor(private readonly opts: TerminalServiceOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? LIVE_HEARTBEAT_MS;
    this.highWater = opts.highWaterBytes ?? 1024 * 1024;
  }

  get count(): number {
    return this.sessions.size;
  }

  countFor(botId: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.botId === botId) n++;
    return n;
  }

  /** Closes every terminal (runner shutdown). */
  async close(): Promise<void> {
    for (const s of [...this.sessions.values()]) s.dispose('runner stopping');
  }

  async handle(socket: TerminalSocket, botId: string, size: { cols: number; rows: number }): Promise<void> {
    const { containers, log } = this.opts;
    const send = (msg: TerminalServerMessage) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(msg));
    };
    const fail = (code: string, message: string) => {
      send({ type: 'error', code, message });
      socket.close(code === 'too_many_terminals' ? 1008 : 1011, code);
    };

    if (this.countFor(botId) >= MAX_TERMINALS_PER_BOT) {
      fail('too_many_terminals', `At most ${MAX_TERMINALS_PER_BOT} terminals per bot`);
      return;
    }

    const id = newId('terminal');
    let closed = false;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    const session: Session = {
      id,
      botId,
      dispose: (reason) => {
        if (disposed) return;
        disposed = true;
        this.sessions.delete(id);
        cleanup?.();
        log.info({ botId, terminalId: id, reason }, 'terminal closed');
        // Ends the shell and its children; the TTY stream closing alone leaves them running in the container.
        containers.killTerminal(botId, id).catch((err: unknown) => {
          log.warn({ botId, terminalId: id, err: (err as Error).message }, 'terminal cleanup failed');
        });
        if (socket.readyState === OPEN) socket.close(1000, reason);
      },
    };
    this.sessions.set(id, session);

    // Listen before the (slow) start so an early close is not missed.
    let alive = true;
    socket.on('pong', () => (alive = true));
    socket.on('close', () => {
      closed = true;
      session.dispose('client closed');
    });
    socket.on('error', (err) => {
      log.debug({ botId, terminalId: id, err: err.message }, 'terminal socket error');
      closed = true;
      session.dispose('socket error');
    });
    const pending: unknown[] = [];
    let onData: ((data: unknown, isBinary: boolean) => void) | null = null;
    socket.on('message', (data, isBinary) => {
      alive = true;
      if (onData) onData(data, isBinary);
      else if (pending.length < 64) pending.push(isBinary ? null : data);
    });

    try {
      const status = await containers.status(botId);
      if (status.status !== 'running') send({ type: 'starting' });
    } catch (err) {
      this.sessions.delete(id);
      disposed = true;
      if (err instanceof ContainerError) fail(err.code, err.message);
      else fail('docker_unavailable', 'Docker is not reachable from the runner');
      return;
    }
    if (closed) return;

    let tty: Awaited<ReturnType<TerminalHost['execTty']>>;
    try {
      tty = await containers.execTty(botId, {
        cmd: ['bash', '-l'],
        workdir: TERMINAL_CWD,
        // Docker sets HOME for the exec user but not USER/LOGNAME.
        env: {
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          USER: 'bot',
          LOGNAME: 'bot',
          AGENTA_TERMINAL: id,
        },
        cols: size.cols,
        rows: size.rows,
      });
    } catch (err) {
      this.sessions.delete(id);
      disposed = true;
      const e = err as Error;
      log.warn({ botId, err: e.message }, 'terminal could not open');
      if (err instanceof ContainerError) fail(err.code, err.message);
      else fail('terminal_failed', `Could not open a terminal: ${e.message}`);
      return;
    }

    const stream = tty.stream;
    let drainTimer: NodeJS.Timeout | null = null;
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, this.heartbeatMs);
    heartbeat.unref();
    cleanup = () => {
      clearInterval(heartbeat);
      if (drainTimer) clearInterval(drainTimer);
      stream.destroy();
    };
    if (closed) {
      // The client left while the shell was starting: the session is already disposed, so clean up here.
      cleanup();
      containers.killTerminal(botId, id).catch(() => undefined);
      return;
    }

    stream.on('data', (chunk: Buffer) => {
      if (socket.readyState !== OPEN) return;
      socket.send(chunk);
      // Backpressure: a slow client pauses the shell's output instead of buffering without bound.
      if (socket.bufferedAmount > this.highWater && !drainTimer) {
        stream.pause();
        drainTimer = setInterval(() => {
          if (socket.bufferedAmount > this.highWater / 4) return;
          if (drainTimer) clearInterval(drainTimer);
          drainTimer = null;
          stream.resume();
        }, 50);
      }
    });
    let ended = false;
    const onEnd = () => {
      if (ended || disposed) return;
      ended = true;
      const timeout = new Promise<null>((r) =>
        setTimeout(() => r(null), this.opts.exitWaitMs ?? 2000).unref(),
      );
      void Promise.race([tty.wait().catch(() => null), timeout]).then((code) => {
        send({ type: 'exit', code });
        session.dispose('shell exited');
      });
    };
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', (err) => {
      log.debug({ botId, terminalId: id, err: err.message }, 'terminal stream error');
      onEnd();
    });

    onData = (data, isBinary) => {
      if (isBinary || data === null) {
        send({ type: 'error', code: 'invalid_message', message: 'Send JSON text frames' });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        json = undefined;
      }
      const parsed = terminalClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        send({
          type: 'error',
          code: 'invalid_message',
          message: `${issue?.path.join('.') || 'message'}: ${issue?.message ?? 'invalid'}`,
        });
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'input') {
        containers.touch(botId);
        stream.write(msg.data);
      } else {
        tty.resize(msg.cols, msg.rows).catch((err: unknown) => {
          log.debug({ botId, terminalId: id, err: (err as Error).message }, 'terminal resize failed');
        });
      }
    };
    for (const data of pending.splice(0)) onData(data, data === null);

    log.info({ botId, terminalId: id }, 'terminal opened');
    send({ type: 'ready', terminalId: id });
  }
}
