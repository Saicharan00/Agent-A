import { randomUUID } from 'node:crypto';
import type { EngineEvent, RunFinishStatus } from '@agenta/shared';
import { parseJsonl } from './jsonl';
import { parseResetTime, toIso } from './limits';
import type { EngineLauncher, EngineProcess } from './process';
import type { EngineAdapter, EngineRunInput } from './types';

// Claude Code adapter: `claude -p --output-format stream-json` inside the bot's computer, mapped to EngineEvents.
// Observed stream format (2.1.296) and flags: docs/engines.md → "Claude Code adapter (F08)".

type Log = { debug(obj: object, msg?: string): void; warn(obj: object, msg?: string): void };
type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

const RESUME_MISSING = /No conversation found with session ID/i;
const LIMIT_TEXT =
  /usage limit reached|hit your (?:\w+ )?limit|(?:5-hour|five-hour|weekly|session|opus|sonnet) limit reached|out of (?:extra )?usage/i;
const FILE_TOOLS: Record<string, 'modified' | undefined> = {
  Write: undefined,
  Edit: 'modified',
  MultiEdit: 'modified',
  NotebookEdit: 'modified',
};

/** True when an engine message reads like a subscription usage limit. */
export function isClaudeLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text);
}

/** Flattens tool_result content (string or content blocks) to text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        isObj(b) ? (str(b.text) ?? (b.type === 'image' ? '[image]' : JSON.stringify(b))) : String(b),
      )
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

/**
 * Stateful mapper for one `claude -p` process: feed every parsed stream-json message to `map`, then call `finish`
 * with the exit code. Never emits run.started/run.finished (the adapter owns those).
 */
export class ClaudeStreamMapper {
  sessionId?: string;
  /** The resumed session no longer exists (the adapter retries without --resume). */
  resumeMissing = false;
  private limited = false;
  private errored = false;
  private result?: Json;
  private readonly calls = new Map<string, { name: string; input: unknown }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  get hitLimit(): boolean {
    return this.limited;
  }

  map(msg: unknown): EngineEvent[] {
    if (!isObj(msg)) return [];
    const sid = str(msg.session_id);
    if (sid) this.sessionId = sid;
    switch (msg.type) {
      case 'stream_event':
        return this.streamEvent(msg);
      case 'assistant':
        return this.assistant(msg);
      case 'user':
        return this.user(msg);
      case 'rate_limit_event':
        return this.rateLimit(msg);
      case 'result':
        return this.resultMsg(msg);
      default:
        // system/init, system/status, system/api_retry, compact boundaries…: nothing for the UI.
        return [];
    }
  }

  /** Events owed after the process exits, and the run's status. */
  finish(exitCode: number | null, stderr = ''): { events: EngineEvent[]; status: RunFinishStatus } {
    const events: EngineEvent[] = [];
    if (!this.resumeMissing && RESUME_MISSING.test(stderr)) this.resumeMissing = true;
    if (this.limited) return { events, status: 'limited' };
    if (!this.limited && isClaudeLimitText(stderr)) {
      events.push(this.limitHit(stderr.trim().slice(-500)));
      return { events, status: 'limited' };
    }
    if (this.result) {
      if (this.result.is_error !== true) return { events, status: 'succeeded' };
      return { events, status: 'failed' };
    }
    if (exitCode === 0) return { events, status: 'succeeded' };
    if (!this.errored && !this.resumeMissing) {
      const tail = stderr.trim().slice(-2000);
      events.push({
        type: 'error',
        message: `Claude Code exited with code ${exitCode ?? 'unknown'} without a result${tail ? `: ${tail.split('\n').at(-1)}` : ''}`,
        ...(tail ? { raw: tail } : {}),
      });
    }
    return { events, status: 'failed' };
  }

  private limitHit(raw: string, resetsAt?: string): EngineEvent {
    this.limited = true;
    const at = resetsAt ?? parseResetTime(raw, this.now());
    return { type: 'limit.hit', engine: 'claude', ...(at ? { resetsAt: at } : {}), raw };
  }

  private streamEvent(msg: Json): EngineEvent[] {
    if (msg.parent_tool_use_id) return []; // a sub-agent's text is not the bot's reply
    const ev = msg.event;
    if (!isObj(ev) || ev.type !== 'content_block_delta' || !isObj(ev.delta)) return [];
    if (ev.delta.type === 'text_delta') {
      const text = str(ev.delta.text);
      return text ? [{ type: 'text.delta', text }] : [];
    }
    return [];
  }

  private assistant(msg: Json): EngineEvent[] {
    const message = isObj(msg.message) ? msg.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const topLevel = !msg.parent_tool_use_id;

    if (msg.error !== undefined || msg.is_api_error_message === true) {
      const text = content
        .map((b) => (isObj(b) ? (str(b.text) ?? '') : ''))
        .join('\n')
        .trim();
      const raw = text || String(msg.error);
      if (this.limited) return [];
      if (msg.error === 'rate_limit' || isClaudeLimitText(raw)) return [this.limitHit(raw)];
      this.errored = true;
      return [{ type: 'error', message: raw, raw: String(msg.error ?? 'api_error') }];
    }

    const out: EngineEvent[] = [];
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && topLevel) {
        const text = str(b.text);
        if (text?.trim()) out.push({ type: 'text.final', text });
      } else if (b.type === 'thinking' && topLevel) {
        const text = str(b.thinking);
        if (text?.trim()) out.push({ type: 'thinking', text });
      } else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
        const callId = str(b.id) ?? randomUUID();
        const name = str(b.name) ?? 'tool';
        this.calls.set(callId, { name, input: b.input });
        out.push({ type: 'tool.call', callId, name, input: b.input ?? {} });
      } else if (isObj(b) && str(b.tool_use_id) && String(b.type).endsWith('_tool_result')) {
        // Server-side tool results (web search/fetch) arrive inside the assistant message.
        out.push({ type: 'tool.result', callId: str(b.tool_use_id)!, output: resultText(b.content) });
      }
    }
    return out;
  }

  private user(msg: Json): EngineEvent[] {
    const message = isObj(msg.message) ? msg.message : {};
    if (!Array.isArray(message.content)) return []; // a replayed prompt (string content)
    const out: EngineEvent[] = [];
    for (const b of message.content) {
      if (!isObj(b) || b.type !== 'tool_result') continue;
      const callId = str(b.tool_use_id) ?? 'unknown';
      const isError = b.is_error === true;
      out.push({
        type: 'tool.result',
        callId,
        output: resultText(b.content),
        ...(isError ? { isError } : {}),
      });
      const call = this.calls.get(callId);
      if (!call || isError || !(call.name in FILE_TOOLS)) continue;
      const input = isObj(call.input) ? call.input : {};
      const path = str(input.file_path) ?? str(input.notebook_path);
      if (!path) continue;
      const meta = isObj(msg.tool_use_result) ? msg.tool_use_result : {};
      const change = FILE_TOOLS[call.name] ?? (meta.type === 'update' ? 'modified' : 'created');
      out.push({ type: 'file.changed', path, change });
    }
    return out;
  }

  private rateLimit(msg: Json): EngineEvent[] {
    const info = isObj(msg.rate_limit_info) ? msg.rate_limit_info : {};
    if (info.status !== 'rejected' || this.limited) return [];
    const raw = JSON.stringify(info);
    return [this.limitHit(raw, toIso(info.resetsAt))];
  }

  private resultMsg(msg: Json): EngineEvent[] {
    this.result = msg;
    const out: EngineEvent[] = [];
    const usage = isObj(msg.usage) ? msg.usage : {};
    const inputTokens =
      num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
    const outputTokens = num(usage.output_tokens);
    const cost = num(msg.total_cost_usd);
    if (inputTokens || outputTokens || cost) {
      out.push({ type: 'usage', inputTokens, outputTokens, costUsdEquivalent: cost });
    }
    if (msg.is_error !== true) return out;

    const errors = Array.isArray(msg.errors)
      ? msg.errors.filter((e): e is string => typeof e === 'string')
      : [];
    const text = [str(msg.result), ...errors].filter(Boolean).join('\n').trim();
    if (errors.some((e) => RESUME_MISSING.test(e))) {
      this.resumeMissing = true;
      return out;
    }
    if (this.limited) return out;
    if (isClaudeLimitText(text)) {
      out.push(this.limitHit(text));
      return out;
    }
    if (!this.errored) {
      this.errored = true;
      const subtype = str(msg.subtype);
      out.push({
        type: 'error',
        message: text || `Claude Code run failed (${subtype ?? 'error'})`,
        ...(subtype ? { raw: subtype } : {}),
      });
    }
    return out;
  }
}

export type ClaudeArgsInput = {
  sessionId: string;
  resume: boolean;
  model?: string;
  systemPromptFile?: string;
  mcpConfigPath?: string;
};

/** argv for one headless Claude Code turn. The prompt is fed on stdin (no argv length/escaping limits). */
export function buildClaudeArgs(a: ClaudeArgsInput): string[] {
  return [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose', // still required by `-p --output-format stream-json` (observed 2.1.296)
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    ...(a.resume ? ['--resume', a.sessionId] : ['--session-id', a.sessionId]),
    ...(a.model ? ['--model', a.model] : []),
    ...(a.systemPromptFile ? ['--append-system-prompt-file', a.systemPromptFile] : []),
    ...(a.mcpConfigPath ? ['--mcp-config', a.mcpConfigPath] : []),
  ];
}

export type ClaudeEngineOptions = {
  launcher: EngineLauncher;
  /** Exec-time credentials (EngineAuth.execEnv('claude')); read per run so a new token works at once. */
  env: () => Record<string, string>;
  log: Log;
  /** SIGINT → SIGKILL grace period on cancel. Default 5 s. */
  killGraceMs?: number;
  /** After SIGKILL, stop waiting for the stream to close. Default 3 s. */
  closeGraceMs?: number;
  now?: () => Date;
  /** Every raw stream-json message (fixture capture in the smoke test). */
  tap?: (msg: unknown) => void;
};

const MAX_STDERR = 64 * 1024;
const RUN_FILES = '.agenta/runs';

type Attempt = { status: RunFinishStatus; sessionId: string; resumeMissing: boolean };

export class ClaudeEngine implements EngineAdapter {
  readonly id = 'claude' as const;
  private readonly killGraceMs: number;
  private readonly closeGraceMs: number;

  constructor(private readonly opts: ClaudeEngineOptions) {
    this.killGraceMs = opts.killGraceMs ?? 5000;
    this.closeGraceMs = opts.closeGraceMs ?? 3000;
  }

  async *run(input: EngineRunInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    const botId = input.bot.id;
    const { launcher } = this.opts;
    // A new session gets an id up front (--session-id), so run.started can carry it immediately.
    let sessionId = input.resumeSessionId ?? randomUUID();
    yield { type: 'run.started', engine: 'claude', sessionId };
    if (signal.aborted) {
      yield { type: 'run.finished', status: 'cancelled', sessionId };
      return;
    }

    const dir = `${RUN_FILES}/${randomUUID()}`;
    let result: Attempt;
    try {
      const promptFile = launcher.writeHomeFile(botId, `${dir}/prompt.md`, input.prompt);
      const systemPromptFile = input.systemPromptAppend.trim()
        ? launcher.writeHomeFile(botId, `${dir}/system.md`, input.systemPromptAppend)
        : undefined;
      const mcpConfigPath = launcher.homeFileExists(botId, input.mcpConfigPath)
        ? input.mcpConfigPath
        : undefined;
      if (!mcpConfigPath)
        this.opts.log.debug({ botId, path: input.mcpConfigPath }, 'no MCP config yet; running without');
      const model = input.model ?? input.bot.model ?? undefined;
      const files = { promptFile, systemPromptFile, mcpConfigPath, model };

      result = yield* this.attempt(
        input,
        { ...files, sessionId, resume: Boolean(input.resumeSessionId) },
        signal,
      );
      if (result.resumeMissing && input.resumeSessionId && !signal.aborted) {
        yield {
          type: 'system',
          message: `The previous Claude Code session (${input.resumeSessionId}) was not found, so this turn started a new session.`,
        };
        sessionId = randomUUID();
        result = yield* this.attempt(input, { ...files, sessionId, resume: false }, signal);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (!signal.aborted) yield { type: 'error', message: `Could not run Claude Code: ${message}` };
      result = { status: signal.aborted ? 'cancelled' : 'failed', sessionId, resumeMissing: false };
    } finally {
      try {
        launcher.removeHomeFile(botId, dir);
      } catch (err) {
        this.opts.log.warn({ botId, err: (err as Error).message }, 'could not remove run files');
      }
    }
    yield { type: 'run.finished', status: result.status, sessionId: result.sessionId };
  }

  private async *attempt(
    input: EngineRunInput,
    a: {
      promptFile: string;
      systemPromptFile?: string;
      mcpConfigPath?: string;
      model?: string;
      sessionId: string;
      resume: boolean;
    },
    signal: AbortSignal,
  ): AsyncGenerator<EngineEvent, Attempt> {
    const botId = input.bot.id;
    const mapper = new ClaudeStreamMapper(this.opts.now);
    const proc = await this.opts.launcher.spawn(botId, {
      cmd: buildClaudeArgs(a),
      env: { ...this.opts.env(), DISPLAY: ':99' },
      workdir: input.cwd,
      stdinFile: a.promptFile,
    });

    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-MAX_STDERR);
    });
    proc.stderr.on('error', () => undefined);
    const stopCancel = this.onAbort(proc, signal);

    let exitCode: number | null;
    let finished = false;
    try {
      const messages = parseJsonl(proc.stdout, {
        onNoise: (line) =>
          this.opts.log.debug({ botId, line: line.slice(0, 500) }, 'claude: non-JSON output'),
        onOversized: (length) => this.opts.log.warn({ botId, length }, 'claude: oversized line dropped'),
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
          this.opts.log.warn({ botId, err: (err as Error).message }, 'claude: output stream error');
      }
      exitCode = await Promise.race([
        proc.wait(),
        delay(signal.aborted ? this.closeGraceMs : 10_000).then(() => null),
      ]);
      finished = true;
    } finally {
      stopCancel();
      // Cancelled (or the consumer stopped iterating): reap the whole group. Tool processes started in the
      // background ignore SIGINT and would outlive the CLI otherwise.
      if (signal.aborted || !finished) await proc.signal('KILL');
      await proc.dispose();
    }

    const sessionId = mapper.sessionId ?? a.sessionId;
    if (signal.aborted) return { status: 'cancelled', sessionId, resumeMissing: false };
    if (stderr.trim()) this.opts.log.debug({ botId, stderr: stderr.slice(-2000) }, 'claude: stderr');
    const done = mapper.finish(exitCode, stderr);
    if (!(a.resume && mapper.resumeMissing)) yield* done.events;
    return { status: done.status, sessionId, resumeMissing: a.resume && mapper.resumeMissing };
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}
