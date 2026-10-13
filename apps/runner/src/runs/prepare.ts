import type { Bot } from '@agenta/db';
import type { Engine } from '@agenta/shared';
import { bootstrapHome, botHomeDir } from '../containers/home';
import type { ContainerManager } from '../containers/manager';
import { renderInstructionFiles, writeInstructionFiles } from '../engines/prompt';
import type { PrepareComputer } from './service';

/**
 * Before a real-engine turn: start the bot's computer on demand, hold a lease so the idle sweep can't stop it
 * mid-run, and render /home/bot/CLAUDE.md + AGENTS.md from the bot's current instructions (memory: F22,
 * the Platform MCP config: F17). The mock engine never touches the computer, so tests and e2e need no Docker.
 */
export function computerPreparer(opts: { containers?: ContainerManager; botsDir: string }): PrepareComputer {
  return async (bot: Bot, engine: Engine) => {
    if (engine === 'mock') return () => undefined;
    if (!opts.containers)
      throw new Error('Docker is disabled for this runner, so bot computers are unavailable');
    await opts.containers.ensureRunning(bot.id);
    const release = opts.containers.acquire(bot.id);
    try {
      const home = botHomeDir(opts.botsDir, bot.id);
      bootstrapHome(home);
      writeInstructionFiles(home, renderInstructionFiles(bot));
    } catch (err) {
      release();
      throw err;
    }
    return release;
  };
}
