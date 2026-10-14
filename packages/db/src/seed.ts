import type { Bot, Thread } from './schema';
import type { Repos } from './repos';

export const ECHO_BOT_SLUG = 'echo-bot';

/**
 * Minimal test seed: one mock-engine "Echo Bot" and its DM thread. Idempotent — re-running
 * reuses the existing bot/thread. Used by tests; `pnpm db:seed` creates the Agent A team (team.ts).
 */
export function seedDb(repos: Repos): { bot: Bot; thread: Thread; created: boolean } {
  let created = false;
  let bot = repos.bots.getBySlug(ECHO_BOT_SLUG);
  if (!bot) {
    bot = repos.bots.create({
      name: 'Echo Bot',
      slug: ECHO_BOT_SLUG,
      role: 'Test bot that echoes your messages (mock engine)',
      instructions: 'Repeat the user message back. Used for development and tests.',
      engine: 'mock',
      avatarColor: '#10b981',
      avatarShape: 'circle',
    });
    created = true;
  }
  let thread = repos.threads.findDm(bot.id);
  if (!thread) {
    thread = repos.threads.create({ kind: 'dm', title: bot.name, memberBotIds: [bot.id] });
    created = true;
  }
  return { bot, thread, created };
}
