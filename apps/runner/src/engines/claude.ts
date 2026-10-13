import { randomUUID } from 'node:crypto';
import type { EngineEvent, RunFinishStatus } from '@agenta/shared';
import { CliEngine, type CliEngineOptions, type CliStreamMapper, type CliTurn } from './cli';
import { parseResetTime, toIso } from './limits';

// Claude Code adapter: `claude -p --output-format stream-json` inside the bot's computer, mapped to EngineEvents.
// Observed stream format (2.1.296) and flags: docs/engines.md → "Claude Code adapter (F08)".

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
export class ClaudeStreamMapper implements CliStreamMapper {
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

export type ClaudeEngineOptions = CliEngineOptions;

export class ClaudeEngine extends CliEngine {
  readonly id = 'claude' as const;
  protected readonly label = 'Claude Code';

  protected newMapper(): ClaudeStreamMapper {
    return new ClaudeStreamMapper(this.opts.now);
  }

  /** New sessions get an id up front (--session-id), so run.started carries it immediately. */
  protected override newSessionId(): string {
    return randomUUID();
  }

  protected command(turn: CliTurn): string[] {
    return buildClaudeArgs({ ...turn, sessionId: turn.sessionId ?? randomUUID() });
  }
}
