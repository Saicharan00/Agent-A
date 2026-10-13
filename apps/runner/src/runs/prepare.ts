import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Bot } from '@agenta/db';
import type { Engine } from '@agenta/shared';
import { bootstrapHome, botHomeDir } from '../containers/home';
import type { ContainerManager } from '../containers/manager';
import { withPlaywrightServer } from '../engines/mcp-config';
import { renderInstructionFiles, writeInstructionFiles } from '../engines/prompt';
import type { PrepareComputer } from './service';

/**
 * Before a real-engine turn: start the bot's computer on demand, hold a lease so the idle sweep can't stop it
 * mid-run, render /home/bot/CLAUDE.md + AGENTS.md from the bot's current instructions (memory: F22) and make
 * sure the MCP config (/home/bot/.agenta/mcp.json) has Playwright (F16; the Platform MCP server: F17), re-issuing the bot's MCP token if the home lost it. The mock engine never touches the computer, so tests and e2e need no Docker.
 */
export function computerPreparer(opts: {
  containers?: ContainerManager;
  botsDir: string;
  /** Re-issues the bot's Platform MCP token if its home lost it (F12; e.g. after a home wipe). */
  ensureToken?: (botId: string) => void;
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
      writeInstructionFiles(home, renderInstructionFiles(bot));
      writeMcpConfig(home);
    } catch (err) {
      release();
      throw err;
    }
    return release;
  };
}

/** Adds Playwright to the bot's MCP config, keeping the servers already in it (atomic replace). */
export function writeMcpConfig(home: string): void {
  const path = join(home, '.agenta', 'mcp.json');
  let existing: string | undefined;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    // first run
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, withPlaywrightServer(existing));
  renameSync(tmp, path);
}
