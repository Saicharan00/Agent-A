import type { EngineEvent, RunFinishStatus } from '@agenta/shared';
import { CliEngine, type CliEngineOptions, type CliStreamMapper, type CliTurn } from './cli';
import { parseResetTime } from './limits';
import { PLAYWRIGHT_MCP_SERVER } from './mcp-config';
import { CONTAINER_HOME, type EngineLauncher } from './process';
import type { EngineRunInput } from './types';

// Codex adapter: `codex exec --json` inside the bot's computer, mapped to EngineEvents.
// Observed JSONL format (codex-cli 0.162.1) and flags: docs/engines.md → "Codex adapter (F09)".

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

const RESUME_MISSING = /no rollout found for thread id|thread\/resume failed/i;
const LIMIT_TEXT = /usage limit|hit your (?:\w+ )?limit|rate limit reached|quota exceeded|out of credits/i;
/** Transient transport errors Codex reports and then recovers from. */
const TRANSIENT = /^Reconnecting\b|^Falling back from WebSockets/i;
const FILE_KINDS: Record<string, 'created' | 'modified' | 'deleted'> = {
  add: 'created',
  update: 'modified',
  delete: 'deleted',
};

export function isCodexLimitText(text: string): boolean {
  return LIMIT_TEXT.test(text);
}

/** MCP tool results: `{ content: [{type:'text', text}] }` → text; anything else → JSON. */
function mcpResultText(result: unknown): string {
  if (isObj(result) && Array.isArray(result.content)) {
    return result.content
      .map((b) =>
        isObj(b) ? (str(b.text) ?? (b.type === 'image' ? '[image]' : JSON.stringify(b))) : String(b),
      )
      .join('\n');
  }
  return result === undefined || result === null
    ? ''
    : typeof result === 'string'
      ? result
      : JSON.stringify(result);
}

/** Stateful mapper for one `codex exec --json` process. */
export class CodexStreamMapper implements CliStreamMapper {
  sessionId?: string;
  resumeMissing = false;
  private limited = false;
  private errored = false;
  private outcome?: 'completed' | 'failed';
  private lastError?: string;
  /** Items whose tool.call was already emitted (item.started). */
  private readonly started = new Set<string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  map(msg: unknown): EngineEvent[] {
    if (!isObj(msg)) return [];
    switch (msg.type) {
      case 'thread.started':
        this.sessionId = str(msg.thread_id) ?? this.sessionId;
        return [];
      case 'item.started':
        return isObj(msg.item) ? this.itemStarted(msg.item) : [];
      case 'item.completed':
        return isObj(msg.item) ? this.itemCompleted(msg.item) : [];
      case 'turn.completed':
        this.outcome = 'completed';
        return this.usage(msg.usage);
      case 'turn.failed': {
        this.outcome = 'failed';
        const message =
          (isObj(msg.error) ? str(msg.error.message) : undefined) ?? this.lastError ?? 'Codex turn failed';
        return this.failure(message);
      }
      case 'error': {
        const message = str(msg.message) ?? '';
        if (TRANSIENT.test(message)) return [];
        this.lastError = message;
        return isCodexLimitText(message) ? this.failure(message) : [];
      }
      default:
        // turn.started, item.updated (todo lists, partial command output): nothing for the UI yet.
        return [];
    }
  }

  finish(exitCode: number | null, stderr = ''): { events: EngineEvent[]; status: RunFinishStatus } {
    const events: EngineEvent[] = [];
    if (RESUME_MISSING.test(stderr)) this.resumeMissing = true;
    if (this.limited) return { events, status: 'limited' };
    if (this.outcome === 'completed') return { events, status: 'succeeded' };
    if (this.outcome === 'failed') return { events, status: 'failed' };
    const tail = stderr.trim().slice(-2000);
    if (isCodexLimitText(tail)) {
      events.push(...this.failure(lastLine(tail)));
      return { events, status: 'limited' };
    }
    if (exitCode === 0) return { events, status: 'succeeded' };
    if (!this.errored && !this.resumeMissing) {
      const why = this.lastError ?? lastLine(tail);
      events.push({
        type: 'error',
        message: `Codex exited with code ${exitCode ?? 'unknown'} without finishing the turn${why ? `: ${why}` : ''}`,
        ...(tail ? { raw: tail } : {}),
      });
    }
    return { events, status: 'failed' };
  }

  private failure(message: string): EngineEvent[] {
    if (this.limited) return [];
    if (isCodexLimitText(message)) {
      this.limited = true;
      const resetsAt = parseResetTime(message, this.now());
      return [{ type: 'limit.hit', engine: 'codex', ...(resetsAt ? { resetsAt } : {}), raw: message }];
    }
    if (this.errored) return [];
    this.errored = true;
    return [{ type: 'error', message }];
  }

  private usage(u: unknown): EngineEvent[] {
    if (!isObj(u)) return [];
    // input_tokens already includes cached_input_tokens (OpenAI usage semantics).
    const inputTokens = num(u.input_tokens);
    const outputTokens = num(u.output_tokens) + num(u.reasoning_output_tokens);
    return inputTokens || outputTokens ? [{ type: 'usage', inputTokens, outputTokens }] : [];
  }

  /** The tool.call for an item, or undefined for items that aren't tool calls. */
  private call(item: Json): EngineEvent | undefined {
    const callId = str(item.id) ?? 'item';
    switch (item.type) {
      case 'command_execution':
        return { type: 'tool.call', callId, name: 'shell', input: { command: item.command } };
      case 'mcp_tool_call':
        return {
          type: 'tool.call',
          callId,
          name: `mcp__${str(item.server) ?? 'unknown'}__${str(item.tool) ?? 'tool'}`,
          input: item.arguments ?? {},
        };
      case 'web_search':
        return { type: 'tool.call', callId, name: 'web_search', input: { query: item.query } };
      case 'file_change':
        return { type: 'tool.call', callId, name: 'apply_patch', input: { changes: item.changes } };
      default:
        return undefined;
    }
  }

  private itemStarted(item: Json): EngineEvent[] {
    const call = this.call(item);
    if (!call) return [];
    this.started.add(str(item.id) ?? 'item');
    return [call];
  }

  private itemCompleted(item: Json): EngineEvent[] {
    const callId = str(item.id) ?? 'item';
    switch (item.type) {
      case 'agent_message': {
        const text = str(item.text);
        return text?.trim() ? [{ type: 'text.final', text }] : [];
      }
      case 'reasoning': {
        const text = str(item.text);
        return text?.trim() ? [{ type: 'thinking', text }] : [];
      }
      case 'error':
        // Non-fatal notices (e.g. transport fallback); real failures arrive as turn.failed.
        return [];
    }
    const call = this.call(item);
    if (!call) return [];
    const out: EngineEvent[] = this.started.has(callId) ? [] : [call];
    const failed = item.status === 'failed' || item.status === 'declined';
    switch (item.type) {
      case 'command_execution': {
        const exit = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const isError = failed || (exit !== undefined && exit !== 0);
        out.push({
          type: 'tool.result',
          callId,
          output: str(item.aggregated_output) ?? '',
          ...(isError ? { isError } : {}),
        });
        break;
      }
      case 'mcp_tool_call': {
        const err = isObj(item.error) ? str(item.error.message) : str(item.error);
        const isError = failed || Boolean(err);
        out.push({
          type: 'tool.result',
          callId,
          output: err ?? mcpResultText(item.result),
          ...(isError ? { isError } : {}),
        });
        break;
      }
      case 'web_search':
        out.push({ type: 'tool.result', callId, output: '' });
        break;
      case 'file_change': {
        const changes = Array.isArray(item.changes) ? item.changes.filter(isObj) : [];
        out.push({
          type: 'tool.result',
          callId,
          output: failed
            ? 'Patch failed'
            : changes.map((c) => `${String(c.kind)} ${String(c.path)}`).join('\n'),
          ...(failed ? { isError: true } : {}),
        });
        if (!failed) {
          for (const c of changes) {
            const path = str(c.path);
            const change = FILE_KINDS[String(c.kind)];
            if (path && change) out.push({ type: 'file.changed', path, change });
          }
        }
        break;
      }
    }
    return out;
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.trim() ?? '';
}

// ---------- argv & config ----------

export type CodexArgsInput = {
  sessionId?: string;
  resume: boolean;
  model?: string;
  developerInstructions?: string;
};

/** TOML basic string (JSON escapes are valid TOML escapes). */
export const tomlString = (s: string): string => JSON.stringify(s);

/** argv for one `codex exec` turn. The prompt is read from stdin (`-`). */
export function buildCodexArgs(a: CodexArgsInput): string[] {
  const opts = [
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    ...(a.model ? ['-m', a.model] : []),
    ...(a.developerInstructions?.trim()
      ? ['-c', `developer_instructions=${tomlString(a.developerInstructions)}`]
      : []),
  ];
  if (a.resume && a.sessionId) return ['codex', 'exec', 'resume', a.sessionId, ...opts, '-'];
  return ['codex', 'exec', ...opts, '-'];
}

type McpServer = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/** Always available to Codex bots (the same server as in the Claude MCP config). */
const DEFAULT_SERVERS: Record<string, McpServer> = { playwright: PLAYWRIGHT_MCP_SERVER };

/** Reads a Claude-style MCP config (`{ "mcpServers": { name: {...} } }`); invalid → {}. */
export function parseMcpConfig(json: string | undefined): Record<string, McpServer> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    const servers = isObj(parsed) && isObj(parsed.mcpServers) ? parsed.mcpServers : {};
    const out: Record<string, McpServer> = {};
    for (const [name, v] of Object.entries(servers)) if (isObj(v)) out[name] = v as McpServer;
    return out;
  } catch {
    return {};
  }
}

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k));
const tomlArray = (a: string[]) => `[${a.map(tomlString).join(', ')}]`;
const tomlTable = (o: Record<string, string>) =>
  `{ ${Object.entries(o)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
    .join(', ')} }`;

/**
 * ~/.codex/config.toml for a bot: no Codex sandbox/approvals (the container is the sandbox) and the same MCP servers
 * as the bot's Claude MCP config (F17 renders that), plus Playwright. Rewritten before every run.
 */
export function renderCodexConfig(servers: Record<string, McpServer>): string {
  const lines = [
    '# Rendered by Agent A before each Codex run. Edits here are overwritten.',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    // Live web search for research (F35): the CLI's top-level --search, which `codex exec` does not take.
    'web_search = "live"',
  ];
  for (const [name, s] of Object.entries({ ...DEFAULT_SERVERS, ...servers })) {
    lines.push('', `[mcp_servers.${tomlKey(name)}]`);
    if (s.url) {
      lines.push(`url = ${tomlString(s.url)}`);
      if (s.headers && Object.keys(s.headers).length) lines.push(`http_headers = ${tomlTable(s.headers)}`);
    } else if (s.command) {
      lines.push(`command = ${tomlString(s.command)}`);
      if (s.args?.length) lines.push(`args = ${tomlArray(s.args)}`);
      if (s.env && Object.keys(s.env).length) lines.push(`env = ${tomlTable(s.env)}`);
    } else {
      lines.pop();
      lines.pop();
    }
  }
  return lines.join('\n') + '\n';
}

const CODEX_DIR = '.codex';

// ---------- engine ----------

/**
 * Writes the bot's ~/.codex/config.toml (from its MCP config) and mirrors /home/bot/AGENTS.md to ~/.codex/AGENTS.md:
 * Codex only reads AGENTS.md from the git root down to its cwd (/home/bot/work), never /home/bot, but always reads
 * the global $CODEX_HOME/AGENTS.md (verified with `codex debug prompt-input`).
 */
export function prepareCodexHome(
  launcher: EngineLauncher,
  input: Pick<EngineRunInput, 'bot' | 'mcpConfigPath'>,
): void {
  const botId = input.bot.id;
  const servers = parseMcpConfig(launcher.readHomeFile(botId, input.mcpConfigPath));
  launcher.writeHomeFile(botId, `${CODEX_DIR}/config.toml`, renderCodexConfig(servers));
  const agents = launcher.readHomeFile(botId, `${CONTAINER_HOME}/AGENTS.md`);
  if (agents !== undefined) launcher.writeHomeFile(botId, `${CODEX_DIR}/AGENTS.md`, agents);
}

export type CodexEngineOptions = CliEngineOptions & {
  /** Copies the shared ChatGPT login into the bot home (EngineAuth.beforeCodexRun). */
  beforeRun?: (botId: string) => Promise<void>;
  /** Copies a refreshed login back (EngineAuth.afterCodexRun). */
  afterRun?: (botId: string) => Promise<void>;
};

export class CodexEngine extends CliEngine {
  readonly id = 'codex' as const;
  protected readonly label = 'Codex';
  // Codex has no system-prompt flag: the text goes in as `-c developer_instructions=…`.
  protected override readonly systemPromptAsFile = false;

  constructor(private readonly codexOpts: CodexEngineOptions) {
    super(codexOpts);
  }

  protected newMapper(): CodexStreamMapper {
    return new CodexStreamMapper(this.opts.now);
  }

  protected command(turn: CliTurn, input: EngineRunInput): string[] {
    return buildCodexArgs({ ...turn, developerInstructions: input.systemPromptAppend });
  }

  protected override async beforeRun(input: EngineRunInput): Promise<void> {
    await this.codexOpts.beforeRun?.(input.bot.id);
    prepareCodexHome(this.opts.launcher, input);
  }

  protected override async afterRun(input: EngineRunInput): Promise<void> {
    try {
      await this.codexOpts.afterRun?.(input.bot.id);
    } catch (err) {
      this.opts.log.warn({ botId: input.bot.id, err: (err as Error).message }, 'codex auth copy-back failed');
    }
  }
}
