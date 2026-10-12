import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { Repos } from '@agenta/db';
import { type AuthEngine, type Engine, type EngineAuthStatus, nowIso } from '@agenta/shared';
import type { ExecHandle, ExecOptions } from '../containers/docker';
import { botHomeDir } from '../containers/home';
import {
  botCodexAuthPath,
  ensurePrivateMode,
  readCodexAuth,
  sameAccount,
  sharedCodexAuthPath,
  syncCodexAuthBack,
  syncCodexAuthIn,
} from './codex-auth';
import { CLAUDE_TOKEN_VAR, claudeTokenProblem } from './claude-token';
import { type SecretSource, redactSecrets } from './secrets';

export { CLAUDE_TOKEN_VAR, claudeTokenProblem };

type Log = {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
};

const CLI_TIMEOUT_MS = 20_000;

export type EngineAuthOptions = {
  secrets: SecretSource;
  /** data/secrets: holds codex/auth.json. */
  secretsDir: string;
  botsDir: string;
  repos: Pick<Repos, 'bots'>;
  /** Used only by `status({ verify: true })` to run the CLI's own status command in a running computer. */
  exec?: (botId: string, opts: ExecOptions) => Promise<ExecHandle>;
  log: Log;
};

const CLAUDE_FIX = [
  'In a sandbox shell in the project folder, run `pnpm auth:claude` (runs `claude setup-token` in a throwaway bot container) and finish the browser sign-in.',
  'Copy the printed token into .env.local as CLAUDE_CODE_OAUTH_TOKEN=… (never paste it into chat).',
  'Press "Re-check" here. No restart is needed.',
  "Fallback: open a bot's Terminal and run `claude` → /login; that login stays in the bot's own home.",
];
const CODEX_FIX = [
  'In a sandbox shell in the project folder, run `pnpm auth:codex` (runs `codex login --device-auth` in a throwaway bot container) and finish the device sign-in.',
  'It saves the login to data/secrets/codex/auth.json (mode 600). Press "Re-check" here.',
  "Fallback: open a bot's Terminal and run `codex login --device-auth`; that login stays in the bot's own home.",
];

/**
 * Engine credentials for bot containers (F06).
 * - Claude: a long-lived subscription token, injected as an env var into engine execs only (never written to
 *   disk inside containers, never part of the container's own Env, never logged).
 * - Codex: a shared auth.json copied into each bot's ~/.codex before start and synced back after runs.
 */
export class EngineAuth {
  constructor(private readonly opts: EngineAuthOptions) {}

  get sharedCodexPath(): string {
    return sharedCodexAuthPath(this.opts.secretsDir);
  }

  claudeToken(): string | undefined {
    return this.opts.secrets.get(CLAUDE_TOKEN_VAR);
  }

  /** Extra env for one engine exec. Pass to ContainerManager.exec({ env }); never to the container spec. */
  execEnv(engine: Engine): Record<string, string> {
    if (engine !== 'claude') return {};
    const token = this.claudeToken();
    return token && claudeTokenProblem(token) === null ? { [CLAUDE_TOKEN_VAR]: token } : {};
  }

  /** Masks the Claude token (and token-shaped strings) in text that may be logged or shown. */
  redact(text: string): string {
    return redactSecrets(text, [this.claudeToken()]);
  }

  /** ContainerManager hook: runs before a bot's container starts, with its home on the host. */
  async prepareHome(botId: string, home: string): Promise<void> {
    const result = await syncCodexAuthIn(this.sharedCodexPath, botCodexAuthPath(home));
    if (result !== 'no-shared' && result !== 'up-to-date') {
      this.opts.log.info({ botId, result }, 'codex auth synced into bot home');
    }
  }

  /** Call before each Codex run (another bot may have refreshed the shared token meanwhile). */
  async beforeCodexRun(botId: string): Promise<void> {
    await this.prepareHome(botId, this.home(botId));
  }

  /** Call after each Codex run: copies a refreshed token back to data/secrets/codex/auth.json. */
  async afterCodexRun(botId: string): Promise<void> {
    const result = await syncCodexAuthBack(this.sharedCodexPath, botCodexAuthPath(this.home(botId)));
    if (result === 'copied-back') this.opts.log.info({ botId }, 'codex token refresh copied back');
    else if (result === 'invalid' || result === 'different-account') {
      this.opts.log.warn({ botId, result }, 'codex auth in bot home not copied back');
    }
  }

  async statuses(opts: { verify?: boolean } = {}): Promise<EngineAuthStatus[]> {
    return Promise.all([this.status('claude', opts), this.status('codex', opts)]);
  }

  async status(engine: AuthEngine, opts: { verify?: boolean } = {}): Promise<EngineAuthStatus> {
    const base = engine === 'claude' ? this.claudeStatus() : this.codexStatus();
    const cli = opts.verify
      ? await this.verifyCli(engine)
      : { checked: false, reason: 'Press "Re-check" to ask the CLI inside a running computer' };
    return { ...base, cli, checkedAt: nowIso() };
  }

  // ---------- internals ----------

  private home(botId: string): string {
    return botHomeDir(this.opts.botsDir, botId);
  }

  private botNamesWith(relPath: string, valid: (path: string) => boolean = existsSync): string[] {
    const out: string[] = [];
    for (const bot of this.opts.repos.bots.list()) {
      const path = join(this.home(bot.id), relPath);
      if (existsSync(path) && valid(path)) out.push(bot.name);
    }
    return out;
  }

  private claudeStatus(): Omit<EngineAuthStatus, 'cli' | 'checkedAt'> {
    const perBotLogins = this.botNamesWith('.claude/.credentials.json');
    const token = this.claudeToken();
    if (token) {
      const problem = claudeTokenProblem(token);
      if (problem) {
        return {
          engine: 'claude',
          state: 'invalid',
          mode: 'token',
          detail: problem,
          fix: CLAUDE_FIX,
          perBotLogins,
        };
      }
      return {
        engine: 'claude',
        state: 'configured',
        mode: 'token',
        detail: `${CLAUDE_TOKEN_VAR} is set. It is injected into each Claude run and never stored in a container.`,
        fix: [],
        perBotLogins,
      };
    }
    if (perBotLogins.length > 0) {
      return {
        engine: 'claude',
        state: 'configured',
        mode: 'per-bot',
        detail: `No shared token. ${perBotLogins.length} bot(s) logged in from their own terminal; other bots cannot use Claude.`,
        fix: CLAUDE_FIX,
        perBotLogins,
      };
    }
    return {
      engine: 'claude',
      state: 'missing',
      mode: 'none',
      detail: `${CLAUDE_TOKEN_VAR} is not set in .env.local and no bot has its own login.`,
      fix: CLAUDE_FIX,
      perBotLogins,
    };
  }

  private codexStatus(): Omit<EngineAuthStatus, 'cli' | 'checkedAt'> {
    const parsed = readCodexAuth(this.sharedCodexPath);
    const shared = parsed?.ok ? parsed.info : null;
    // A bot's copy of the shared login is not its own login; only a different account (or no shared file) is.
    const perBotLogins = this.botNamesWith('.codex/auth.json', (p) => {
      const own = readCodexAuth(p);
      return own?.ok === true && (shared === null || !sameAccount(own.info, shared));
    });
    if (parsed) {
      if (!parsed.ok) {
        return {
          engine: 'codex',
          state: 'invalid',
          mode: 'shared-file',
          detail: `data/secrets/codex/auth.json: ${parsed.reason}.`,
          fix: CODEX_FIX,
          perBotLogins,
        };
      }
      if (ensurePrivateMode(this.sharedCodexPath)) {
        this.opts.log.warn({}, 'tightened data/secrets/codex/auth.json to mode 600');
      }
      const what =
        parsed.info.kind === 'api-key'
          ? 'an OpenAI API key (billed per use, not your ChatGPT plan)'
          : `a ChatGPT login${parsed.info.plan ? ` (${parsed.info.plan} plan)` : ''}`;
      return {
        engine: 'codex',
        state: 'configured',
        mode: 'shared-file',
        detail: `data/secrets/codex/auth.json holds ${what}. It is copied into each bot before start; refreshed tokens are copied back.`,
        fix: [],
        perBotLogins,
      };
    }
    if (perBotLogins.length > 0) {
      return {
        engine: 'codex',
        state: 'configured',
        mode: 'per-bot',
        detail: `No shared login. ${perBotLogins.length} bot(s) logged in from their own terminal; other bots cannot use Codex.`,
        fix: CODEX_FIX,
        perBotLogins,
      };
    }
    return {
      engine: 'codex',
      state: 'missing',
      mode: 'none',
      detail: 'data/secrets/codex/auth.json does not exist and no bot has its own login.',
      fix: CODEX_FIX,
      perBotLogins,
    };
  }

  /** Runs the CLI's zero-cost status command (no prompt is sent) inside a running bot computer. */
  private async verifyCli(engine: AuthEngine): Promise<EngineAuthStatus['cli']> {
    if (!this.opts.exec) return { checked: false, reason: 'Docker is disabled for this runner' };
    const bot = this.opts.repos.bots.list().find((b) => b.status === 'running');
    if (!bot) return { checked: false, reason: 'Start any bot computer to let the CLI confirm the login' };
    try {
      if (engine === 'codex') await this.beforeCodexRun(bot.id);
      const cmd = engine === 'claude' ? ['claude', 'auth', 'status', '--json'] : ['codex', 'login', 'status'];
      const { code, output } = await this.capture(bot.id, {
        cmd,
        env: this.execEnv(engine),
        workdir: '/home/bot',
      });
      let ok = code === 0;
      if (engine === 'claude') {
        try {
          ok = (JSON.parse(output) as { loggedIn?: unknown }).loggedIn === true;
        } catch {
          // non-JSON output: rely on the exit code
        }
      }
      return { checked: true, ok, botId: bot.id, output: this.redact(output).trim().slice(0, 500) };
    } catch (err) {
      this.opts.log.warn(
        { engine, botId: bot.id, err: this.redact((err as Error).message) },
        'cli auth check failed',
      );
      return { checked: false, botId: bot.id, reason: this.redact((err as Error).message) };
    }
  }

  private async capture(botId: string, opts: ExecOptions): Promise<{ code: number; output: string }> {
    const exec = this.opts.exec!;
    const h = await exec(botId, opts);
    let output = '';
    const add = (c: Buffer) => {
      if (output.length < 8_000) output += c.toString('utf8');
    };
    h.stdout.on('data', add);
    h.stderr.on('data', add);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLI status check timed out')), CLI_TIMEOUT_MS);
    });
    try {
      const done = Promise.all([h.wait(), finished(h.stdout), finished(h.stderr)]);
      const [code] = await Promise.race([done, timeout]);
      return { code, output };
    } finally {
      clearTimeout(timer);
    }
  }
}
