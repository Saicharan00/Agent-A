import type { Bot, Memory, Repos, Run } from '@agenta/db';
import {
  PLATFORM_TOOL_PREFIX,
  type PlatformToolInput,
  type PlatformToolName,
  platformToolInputs,
} from '@agenta/shared';
import { z } from 'zod';
import type { ThreadService } from '../threads/service';

type Log = { info(obj: object, msg?: string): void; debug(obj: object, msg?: string): void };

/** A tool call the platform refused; `message` is shown to the calling bot. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const PLATFORM_TOOL_DESCRIPTIONS: Record<PlatformToolName, string> = {
  whoami: 'Who you are on the team: your id, handle, role, whether you lead, and your current run.',
  list_bots: 'Your teammates (and you): handle, name, role, engine and whether their computer is running.',
  list_threads: 'The conversations you are a member of (direct messages with the owner and group chats).',
  read_thread: 'The latest messages of a thread you are a member of, oldest first.',
  post_message: 'Post a message as yourself in a thread you are a member of.',
  ask_bot:
    'Ask a teammate to do something. Posts your message in their thread (default: their direct messages with ' +
    'the owner) and starts their turn. Returns at once with a run id; check it later with get_run_status.',
  get_run_status: "A run's status and, once it has finished, the bot's reply.",
  save_memory:
    'Save something worth remembering: scope "bot" is only for you, "shared" is for the whole team. ' +
    'Never save secrets.',
  search_memory: 'Search your memories and the team’s shared memories by keywords.',
};

const MAX_REPLY_CHARS = 20_000;
const MAX_MEMORY_CHARS = 2_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);

type Handlers = { [N in PlatformToolName]: (bot: Bot, input: PlatformToolInput<N>) => unknown };

export type PlatformToolsOptions = {
  repos: Repos;
  threads: Pick<ThreadService, 'postAsBot' | 'askBot'>;
  log: Log;
};

/**
 * The Platform MCP tools (PLAN F17), independent of the transport: the MCP server and the mock engine both call
 * `call(bot, name, input)`. The calling bot is always the authenticated one; results are plain JSON objects.
 */
export class PlatformTools {
  constructor(private readonly opts: PlatformToolsOptions) {}

  /** The turn the bot is in now (a bot runs one turn at a time), so calls can be tied to it. */
  currentRun(botId: string): Run | undefined {
    return this.opts.repos.runs.list({ botId, status: 'running', limit: 1 })[0];
  }

  async call(bot: Bot, name: string, input: unknown): Promise<unknown> {
    const tool = name.startsWith(PLATFORM_TOOL_PREFIX) ? name.slice(PLATFORM_TOOL_PREFIX.length) : name;
    if (!Object.hasOwn(platformToolInputs, tool)) throw new ToolError('unknown_tool', `Unknown tool ${name}`);
    const key = tool as PlatformToolName;
    const parsed = platformToolInputs[key].safeParse(input ?? {});
    if (!parsed.success)
      throw new ToolError('invalid_input', `Invalid input: ${z.prettifyError(parsed.error)}`);
    this.opts.log.info({ botId: bot.id, tool: key }, 'platform tool call');
    this.opts.log.debug({ botId: bot.id, tool: key, input: parsed.data }, 'platform tool input');
    const handler = this.handlers[key] as (bot: Bot, input: unknown) => unknown;
    return handler(bot, parsed.data);
  }

  private bot(ref: string): Bot {
    const { bots } = this.opts.repos;
    const bot = bots.getBySlug(ref.replace(/^@/, '').toLowerCase()) ?? bots.get(ref);
    if (!bot) throw new ToolError('bot_not_found', `No teammate called ${ref}; see list_bots`);
    return bot;
  }

  private handle(botId: string | null): string {
    return (botId && this.opts.repos.bots.get(botId)?.slug) ?? 'former-teammate';
  }

  private readonly handlers: Handlers = {
    whoami: (bot) => ({
      id: bot.id,
      handle: bot.slug,
      name: bot.name,
      role: bot.role,
      is_lead: bot.isLead,
      engine: bot.engine,
      dm_thread_id: this.opts.repos.threads.findDm(bot.id)?.id ?? null,
      current_run_id: this.currentRun(bot.id)?.id ?? null,
    }),

    list_bots: (bot) =>
      this.opts.repos.bots.list().map((b) => ({
        id: b.id,
        handle: b.slug,
        name: b.name,
        role: b.role,
        is_lead: b.isLead,
        engine: b.engine,
        computer: b.status,
        ...(b.id === bot.id ? { you: true } : {}),
      })),

    list_threads: (bot) =>
      this.opts.repos.threads.list({ botId: bot.id }).map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
        members: this.opts.repos.threads.listMembers(t.id).map((b) => b.slug),
        updated_at: t.updatedAt,
      })),

    read_thread: (bot, { thread_id, limit }) => {
      const { repos } = this.opts;
      const thread = repos.threads.get(thread_id);
      if (!thread || !repos.threads.isMember(thread_id, bot.id)) {
        throw new ToolError('thread_not_found', `No thread ${thread_id} that you are a member of`);
      }
      return {
        id: thread.id,
        kind: thread.kind,
        title: thread.title,
        messages: repos.messages.listByThread(thread_id, { limit }).map((m) => ({
          id: m.id,
          author:
            m.authorType === 'user'
              ? 'owner'
              : m.authorType === 'system'
                ? 'system'
                : this.handle(m.authorBotId),
          at: m.createdAt,
          text: m.contentMd,
        })),
      };
    },

    post_message: (bot, { thread_id, text }) => {
      const m = this.opts.threads.postAsBot(bot, thread_id, text);
      return { message_id: m.id, thread_id: m.threadId };
    },

    ask_bot: (bot, { bot: ref, message, thread_id }) => {
      const target = this.bot(ref);
      const { message: m, run } = this.opts.threads.askBot(bot, target, message, {
        threadId: thread_id,
        parentRun: this.currentRun(bot.id),
      });
      return {
        run_id: run.id,
        status: run.status,
        thread_id: m.threadId,
        message_id: m.id,
        bot: target.slug,
      };
    },

    get_run_status: (_bot, { run_id }) => {
      const { repos } = this.opts;
      const run = repos.runs.get(run_id);
      if (!run) throw new ToolError('run_not_found', `Run ${run_id} not found`);
      const reply = repos.messages.getByRun(run.id)?.contentMd;
      return {
        id: run.id,
        bot: this.handle(run.botId),
        status: run.status,
        trigger: run.trigger,
        thread_id: run.threadId,
        created_at: run.createdAt,
        started_at: run.startedAt,
        finished_at: run.finishedAt,
        error: run.error,
        reply: reply === undefined ? null : clip(reply, MAX_REPLY_CHARS),
      };
    },

    save_memory: (bot, { title, content, scope, tags }) => {
      const m = this.opts.repos.memories.create({
        scope,
        botId: scope === 'bot' ? bot.id : null,
        title,
        contentMd: content,
        tags,
        sourceRunId: this.currentRun(bot.id)?.id ?? null,
      });
      return { id: m.id, scope: m.scope, title: m.title };
    },

    search_memory: (bot, { query, scope, limit }) => {
      const { memories } = this.opts.repos;
      const pool: Memory[] = [
        ...(scope === 'shared' ? [] : memories.list({ scope: 'bot', botId: bot.id })),
        ...(scope === 'bot' ? [] : memories.list({ scope: 'shared' })),
      ];
      return rankMemories(pool, query)
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          scope: m.scope,
          title: m.title,
          content: clip(m.contentMd, MAX_MEMORY_CHARS),
          tags: m.tags,
          updated_at: m.updatedAt,
        }));
    },
  };
}

/**
 * Keyword match, best first: each query word found in the title counts 2, in the tags or text 1; memories that
 * match no word are dropped. Ties keep the newest first (the repo's order).
 * shortcut: substring scoring over every memory of the bot, fine for hundreds; F22 can move it to SQLite FTS.
 */
export function rankMemories(pool: Memory[], query: string): Memory[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return pool
    .map((m) => {
      const title = m.title.toLowerCase();
      const rest = `${m.contentMd} ${m.tags.join(' ')}`.toLowerCase();
      const score = words.reduce((s, w) => s + (title.includes(w) ? 2 : 0) + (rest.includes(w) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
}
