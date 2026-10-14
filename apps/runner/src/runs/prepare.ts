import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { type Bot, type TeamSkill, loadSkills } from '@agenta/db';
import type { Engine } from '@agenta/shared';
import { bootstrapHome, botHomeDir } from '../containers/home';
import type { ContainerManager } from '../containers/manager';
import { MCP_TOKEN_FILE } from '../bots/mcp-token';
import { withManagedServers } from '../engines/mcp-config';
import { type InstructionMemory, renderInstructionFiles, writeInstructionFiles } from '../engines/prompt';
import type { PrepareComputer } from './service';

/**
 * Before a real-engine turn: start the bot's computer on demand, hold a lease so the idle sweep can't stop it
 * mid-run, render /home/bot/CLAUDE.md + AGENTS.md from the bot's current instructions and memory (F22) and make
 * sure the MCP config (/home/bot/.agenta/mcp.json) has Playwright (F16) and the Platform MCP server (F17), re-issuing
 * the bot's MCP token if the home lost it. The mock engine never touches the computer, so tests and e2e need no Docker.
 */
export function computerPreparer(opts: {
  containers?: ContainerManager;
  botsDir: string;
  /** Re-issues the bot's Platform MCP token if its home lost it (F12; e.g. after a home wipe). */
  ensureToken?: (botId: string) => void;
  /** The Platform MCP URL as bots reach it (http://host.docker.internal:<port>/mcp); unset: not configured. */
  platformMcpUrl?: string;
  /** templates/team/skills (F21); unset: bots get no skills. */
  skillsDir?: string;
  /** The memory rendered into the bot's instruction files (F22); unset: none. */
  memories?: (botId: string) => InstructionMemory[];
}): PrepareComputer {
  return async (bot: Bot, engine: Engine) => {
    if (engine === 'mock') return () => undefined;
    if (!opts.containers)
      throw new Error('Docker is disabled for this runner, so bot computers are unavailable');
    await opts.containers.ensureRunning(bot.id);
    const release = opts.containers.acquire(bot.id);
    try {
      const home = botHomeDir(opts.botsDir, bot.id);
      bootstrapHome(home);
      opts.ensureToken?.(bot.id);
      renderHome(home, bot, opts.skillsDir, opts.memories?.(bot.id));
      writeMcpConfig(home, opts.platformMcpUrl);
    } catch (err) {
      release();
      throw err;
    }
    return release;
  };
}

/**
 * Renders the bot's instruction files (with its memory) and its skills (`settings.skills`, from `skillsDir`) into its home.
 * Runs before every real-engine turn and when the computer starts, so the files are there from the first start.
 */
export function renderHome(
  home: string,
  bot: Bot,
  skillsDir?: string,
  memories: InstructionMemory[] = [],
): void {
  const all = skillsDir ? loadSkills(skillsDir) : new Map<string, TeamSkill>();
  const skills = (bot.settings.skills ?? []).flatMap((n) => all.get(n) ?? []);
  writeInstructionFiles(home, renderInstructionFiles(bot, memories, skills));
  writeSkills(home, skills);
}

const MANAGED_SKILL = '.agenta-managed';

/**
 * Copies the skills into ~/.claude/skills/<name>/ (marked as ours) and removes ours the bot no longer has.
 * A skill folder the bot or owner made by hand (no marker) is never touched.
 */
export function writeSkills(home: string, skills: TeamSkill[]): void {
  const root = join(home, '.claude', 'skills');
  mkdirSync(root, { recursive: true });
  const ours = (name: string) => existsSync(join(root, name, MANAGED_SKILL));
  const wanted = new Set(skills.map((s) => s.name));
  for (const name of readdirSync(root))
    if (!wanted.has(name) && ours(name)) rmSync(join(root, name), { recursive: true, force: true });
  for (const s of skills) {
    const dest = join(root, s.name);
    if (existsSync(dest) && !ours(s.name)) continue;
    rmSync(dest, { recursive: true, force: true });
    cpSync(s.dir, dest, { recursive: true });
    writeFileSync(
      join(dest, MANAGED_SKILL),
      'Copied from the Agent A team template; replaced before each run.\n',
    );
  }
}

/**
 * Sets the runner-managed servers in the bot's MCP config, keeping the others (atomic replace). With `platformUrl`,
 * the Platform MCP entry carries the token from the bot's home, so the file is private to the bot user (0600).
 */
export function writeMcpConfig(home: string, platformUrl?: string): void {
  const path = join(home, '.agenta', 'mcp.json');
  let existing: string | undefined;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    // first run
  }
  let token: string | undefined;
  try {
    token = readFileSync(join(home, MCP_TOKEN_FILE), 'utf8').trim() || undefined;
  } catch {
    // no token (yet): the bot runs without the Platform MCP server
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    withManagedServers(existing, platformUrl && token ? { url: platformUrl, token } : undefined),
    {
      mode: 0o600,
    },
  );
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
