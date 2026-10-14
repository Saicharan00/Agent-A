import { randomUUID } from 'node:crypto';
import type { Engine, EngineEvent, RunFinishStatus } from '@agenta/shared';
import { parseJsonl } from './jsonl';
import type { EngineLauncher, EngineProcess } from './process';
import type { EngineAdapter, EngineRunInput } from './types';

// Shared run loop for engines that are a JSONL-streaming CLI in the bot's computer (Claude Code F08, Codex F09):
// per-run prompt files, spawn, map stdout, cancel (SIGINT → SIGKILL → group reap), one retry when the resumed
// session is gone. Each engine supplies its argv, its stream mapper and optional before/after hooks.

export type Log = {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
};

export type CliEngineOptions = {
  launcher: EngineLauncher;
  /** Exec-time credentials (engine token, the bot's connector tokens); read per run so a new token works at once. */
  env: (botId: string) => Record<string, string>;
  log: Log;
  /** SIGINT → SIGKILL grace period on cancel. Default 5 s. */
  killGraceMs?: number;
  /** After SIGKILL, stop waiting for the stream to close. Default 3 s. */
  closeGraceMs?: number;
  now?: () => Date;
  /** Every raw JSONL message (fixture capture in smoke tests). */
  tap?: (msg: unknown) => void;
};

/** One CLI invocation's parameters (container paths). */
export type CliTurn = {
  promptFile: string;
  systemPromptFile?: string;
  mcpConfigPath?: string;
  model?: string;
  /** Session to resume, or the id chosen up front for a new one (if the CLI supports it). */
  sessionId?: string;
  resume: boolean;
};

export interface CliStreamMapper {
  readonly sessionId?: string;
  /** The resumed session no longer exists. */
  readonly resumeMissing: boolean;
  map(msg: unknown): EngineEvent[];
  /** Events owed after the process exits, and the run's status. */
  finish(exitCode: number | null, stderr: string): { events: EngineEvent[]; status: RunFinishStatus };
}

const MAX_STDERR = 64 * 1024;
/** Error code for a CLI that could not be started (setup or exec failed before it produced output). */
export const EXEC_FAILED = 'exec_failed';
const RUN_FILES = '.agenta/runs';

type Attempt = { status: RunFinishStatus; sessionId?: string; resumeMissing: boolean };

export abstract class CliEngine implements EngineAdapter {
  abstract readonly id: Exclude<Engine, 'mock'>;
  /** Human name for messages ("Claude Code"). */
  protected abstract readonly label: string;
  protected readonly killGraceMs: number;
  protected readonly closeGraceMs: number;

  constructor(protected readonly opts: CliEngineOptions) {
    this.killGraceMs = opts.killGraceMs ?? 5000;
    this.closeGraceMs = opts.closeGraceMs ?? 3000;
  }

  protected abstract newMapper(): CliStreamMapper;
  protected abstract command(turn: CliTurn, input: EngineRunInput): string[];

  /** A new session's id chosen before the CLI starts, if the CLI accepts one. */
  protected newSessionId(): string | undefined {
    return undefined;
  }

  /** Whether the system prompt text goes to the CLI as a file (`CliTurn.systemPromptFile`). */
  protected readonly systemPromptAsFile: boolean = true;

  /** Runs before the CLI (e.g. sync credentials and config into the home). A throw fails the run. */
  protected async beforeRun(_input: EngineRunInput): Promise<void> {}

  /** Runs after the CLI ended, whatever the outcome (also on cancel). Must not throw. */
  protected async afterRun(_input: EngineRunInput): Promise<void> {}

  async *run(input: EngineRunInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    const botId = input.bot.id;
    const { launcher, log } = this.opts;
    let sessionId = input.resumeSessionId ?? this.newSessionId();
    yield { type: 'run.started', engine: this.id, ...(sessionId ? { sessionId } : {}) };
    if (signal.aborted) {
      yield finished('cancelled', sessionId);
      return;
    }

    const dir = `${RUN_FILES}/${randomUUID()}`;
    let ran = false;
    let result: Attempt;
    try {
      await this.beforeRun(input);
      ran = true;
      const promptFile = launcher.writeHomeFile(botId, `${dir}/prompt.md`, input.prompt);
      const systemPromptFile =
        this.systemPromptAsFile && input.systemPromptAppend.trim()
          ? launcher.writeHomeFile(botId, `${dir}/system.md`, input.systemPromptAppend)
          : undefined;
      const mcpConfigPath = launcher.homeFileExists(botId, input.mcpConfigPath)
        ? input.mcpConfigPath
        : undefined;
      if (!mcpConfigPath)
        log.debug({ botId, path: input.mcpConfigPath }, 'no MCP config yet; running without');
      const model = input.model ?? input.bot.model ?? undefined;
      const base = { promptFile, systemPromptFile, mcpConfigPath, model };

      result = yield* this.attempt(
        input,
        { ...base, sessionId, resume: Boolean(input.resumeSessionId) },
        signal,
      );
      if (result.resumeMissing && input.resumeSessionId && !signal.aborted) {
        yield {
          type: 'system',
          message: `The previous ${this.label} session (${input.resumeSessionId}) was not found, so this turn started a new session.`,
        };
        sessionId = this.newSessionId();
        result = yield* this.attempt(input, { ...base, sessionId, resume: false }, signal);
      }
    } catch (err) {
      if (!signal.aborted)
        yield {
          type: 'error',
          message: `Could not run ${this.label}: ${(err as Error).message}`,
          code: EXEC_FAILED,
        };
      result = { status: signal.aborted ? 'cancelled' : 'failed', sessionId, resumeMissing: false };
    } finally {
      try {
        launcher.removeHomeFile(botId, dir);
      } catch (err) {
        log.warn({ botId, err: (err as Error).message }, 'could not remove run files');
      }
      if (ran) await this.afterRun(input);
    }
    yield finished(result.status, result.sessionId);
  }

  private async *attempt(
    input: EngineRunInput,
    turn: CliTurn,
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent, Attempt> {
    const botId = input.bot.id;
    const { log } = this.opts;
    const mapper = this.newMapper();
    const proc = await this.opts.launcher.spawn(botId, {
      cmd: this.command(turn, input),
      env: { ...this.opts.env(botId), DISPLAY: ':99' },
      workdir: input.cwd,
      stdinFile: turn.promptFile,
    });

    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-MAX_STDERR);
    });
    proc.stderr.on('error', () => undefined);
    const stopCancel = this.onAbort(proc, signal);

    let exitCode: number | null;
    let ended = false;
    try {
      const messages = parseJsonl(proc.stdout, {
        onNoise: (line) => log.debug({ botId, line: line.slice(0, 500) }, `${this.id}: non-JSON output`),
        onOversized: (length) => log.warn({ botId, length }, `${this.id}: oversized line dropped`),
      });
      try {
        for await (const msg of messages) {
          if (signal.aborted) continue; // drain until the process dies; nothing more for the UI
          this.opts.tap?.(msg);
          yield* mapper.map(msg);
        }
      } catch (err) {
        // stream destroyed by the cancel fallback, or the exec connection broke
        if (!signal.aborted)
          log.warn({ botId, err: (err as Error).message }, `${this.id}: output stream error`);
      }
      exitCode = await Promise.race([
        proc.wait(),
        delay(signal.aborted ? this.closeGraceMs : 10_000).then(() => null),
      ]);
      ended = true;
    } finally {
      stopCancel();
      // Cancelled (or the consumer stopped iterating): reap the whole group. Tool processes started in the
      // background ignore SIGINT and would outlive the CLI otherwise.
      if (signal.aborted || !ended) await proc.signal('KILL');
      await proc.dispose();
    }

    const sessionId = mapper.sessionId ?? turn.sessionId;
    if (signal.aborted) return { status: 'cancelled', sessionId, resumeMissing: false };
    if (stderr.trim()) log.debug({ botId, stderr: stderr.slice(-2000) }, `${this.id}: stderr`);
    const done = mapper.finish(exitCode, stderr);
    const resumeMissing = turn.resume && mapper.resumeMissing;
    if (!resumeMissing) yield* done.events;
    return { status: done.status, sessionId, resumeMissing };
  }

  /** Cancel: SIGINT to the process group, SIGKILL after the grace period, then stop waiting for the stream. */
  private onAbort(proc: EngineProcess, signal: AbortSignal): () => void {
    const timers: NodeJS.Timeout[] = [];
    const onAbort = () => {
      void proc.signal('INT');
      timers.push(
        setTimeout(() => {
          void proc.signal('KILL');
          timers.push(setTimeout(() => proc.stdout.destroy(), this.closeGraceMs));
        }, this.killGraceMs),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return () => {
      signal.removeEventListener('abort', onAbort);
      for (const t of timers) clearTimeout(t);
    };
  }
}

function finished(status: RunFinishStatus, sessionId?: string): EngineEvent {
  return { type: 'run.finished', status, ...(sessionId ? { sessionId } : {}) };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}
