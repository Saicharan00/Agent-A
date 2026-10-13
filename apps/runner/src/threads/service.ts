import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Bot, Message, Repos, Run } from '@agenta/db';
import {
  INBOX_DIR,
  type InboxUploadResponse,
  type LiveMessage,
  type MessagePage,
  type MessagePageQuery,
  type MessageView,
  type RunView,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadView,
  composeUserMessage,
  composeUserPrompt,
  messagePageQuerySchema,
  runViewSchema,
  sanitizeInboxName,
  sendMessageRequestSchema,
} from '@agenta/shared';
import type { BotService } from '../bots/service';
import type { EventBus } from '../bus';
import { botHomeDir } from '../containers/home';
import type { RunService } from '../runs/service';

type Log = { info(obj: object, msg?: string): void; debug(obj: object, msg?: string): void };

export class ThreadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export type ThreadServiceOptions = {
  repos: Repos;
  bus: EventBus;
  log: Log;
  botsDir: string;
  bots: Pick<BotService, 'view'>;
  runs: Pick<RunService, 'enqueue'>;
};

export function toMessageView(m: Message): MessageView {
  return {
    id: m.id,
    threadId: m.threadId,
    authorType: m.authorType,
    authorBotId: m.authorBotId,
    contentMd: m.contentMd,
    runId: m.runId,
    mentions: m.mentions,
    createdAt: m.createdAt,
  };
}

export function toRunView(run: Run): RunView {
  return runViewSchema.parse(run);
}

/** The bot's chat inbox on the runner's disk (mounted at INBOX_DIR in its computer). */
export function inboxDir(botsDir: string, botId: string): string {
  return join(botHomeDir(botsDir, botId), 'work', 'inbox');
}

/**
 * Direct chat (PLAN F13): reading a thread's history and posting the owner's messages. Posting writes the user
 * message, publishes it on `thread:<id>` and queues one run per addressed bot (in a DM: the DM's bot). Group-chat
 * routing (@mentions) arrives with F18; until then a group message is stored without starting runs.
 */
export class ThreadService {
  constructor(private readonly opts: ThreadServiceOptions) {}

  private thread(id: string) {
    const thread = this.opts.repos.threads.get(id);
    if (!thread) throw new ThreadError('thread_not_found', `Thread ${id} not found`, 404);
    return thread;
  }

  get(id: string): ThreadView {
    const thread = this.thread(id);
    const activity = this.opts.repos.runs.lastActivityByBot();
    return {
      ...thread,
      members: this.opts.repos.threads.listMembers(id).map((b) => this.opts.bots.view(b, activity)),
    };
  }

  /** A page of history, oldest first: the newest `limit` messages, or the ones just before `before`. */
  messages(id: string, query: MessagePageQuery): MessagePage {
    this.thread(id);
    const q = messagePageQuerySchema.parse(query);
    if (q.before && this.opts.repos.messages.get(q.before)?.threadId !== id) {
      throw new ThreadError('message_not_found', `Message ${q.before} is not in this thread`, 404);
    }
    const rows = this.opts.repos.messages.listByThread(id, { before: q.before, limit: q.limit + 1 });
    const hasMore = rows.length > q.limit;
    return { messages: (hasMore ? rows.slice(1) : rows).map(toMessageView), hasMore };
  }

  /** The bots a new owner message in this thread is addressed to. */
  private recipients(threadId: string, kind: string): Bot[] {
    if (kind !== 'dm') return [];
    return this.opts.repos.threads.listMembers(threadId);
  }

  send(id: string, body: SendMessageRequest): SendMessageResponse {
    const { repos, log } = this.opts;
    const thread = this.thread(id);
    if (thread.archivedAt) throw new ThreadError('thread_archived', 'This conversation is archived', 409);
    const req = sendMessageRequestSchema.parse(body);
    const recipients = this.recipients(id, thread.kind);
    const archived = recipients.find((b) => b.archivedAt);
    if (archived) {
      throw new ThreadError('bot_archived', `${archived.name} is archived; restore it to chat`, 409);
    }
    if (req.attachments.length > 0) {
      // Attachments are uploaded to the (DM) bot's inbox first; refuse names that aren't there.
      const bot = recipients[0];
      if (!bot) throw new ThreadError('no_recipient', 'Attachments need a bot to send them to', 400);
      for (const name of req.attachments) {
        if (!existsSync(join(inboxDir(this.opts.botsDir, bot.id), name))) {
          throw new ThreadError('attachment_not_found', `Attachment ${name} was not uploaded`, 400);
        }
      }
    }

    const message = repos.messages.create({
      threadId: id,
      authorType: 'user',
      contentMd: composeUserMessage(req.content, req.attachments),
    });
    const prompt = composeUserPrompt(req.content, req.attachments);
    const runs: Run[] = [];
    for (const bot of recipients) {
      const run = this.opts.runs.enqueue({ botId: bot.id, threadId: id, trigger: 'user', prompt });
      runs.push(run);
      // The bot has now seen everything up to this message. Keep the stored engine: a session id from the
      // bot's previous engine must never be resumed by another one.
      const session = repos.sessions.get(bot.id, id);
      repos.sessions.upsert({
        botId: bot.id,
        threadId: id,
        engine: session?.engine ?? run.engine,
        lastSeenMessageId: message.id,
      });
    }
    const stored = runs[0] ? (repos.messages.setRunId(message.id, runs[0].id) ?? message) : message;
    this.publish(stored);
    log.info({ threadId: id, messageId: message.id, runs: runs.map((r) => r.id) }, 'message posted');
    return { message: toMessageView(stored), runs: runs.map(toRunView) };
  }

  /** Saves an attachment into the bot's inbox under a safe, unused name. */
  saveToInbox(botId: string, rawName: string, data: Buffer): InboxUploadResponse {
    const bot = this.opts.repos.bots.get(botId);
    if (!bot) throw new ThreadError('bot_not_found', `Bot ${botId} not found`, 404);
    if (bot.archivedAt) throw new ThreadError('bot_archived', `${bot.name} is archived`, 409);
    const dir = inboxDir(this.opts.botsDir, botId);
    mkdirSync(dir, { recursive: true });
    const wanted = sanitizeInboxName(rawName);
    const ext = extname(wanted);
    const stem = ext ? wanted.slice(0, -ext.length) : wanted;
    for (let i = 0; i < 1000; i++) {
      const name = i === 0 ? wanted : `${stem}-${i}${ext}`;
      try {
        // 'wx' fails if the name is taken, so two uploads of "notes.txt" never overwrite each other.
        writeFileSync(join(dir, name), data, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      const size = statSync(join(dir, name)).size;
      this.opts.log.debug({ botId, name, size }, 'attachment saved');
      return { name, path: `${INBOX_DIR}/${name}`, size };
    }
    throw new ThreadError('inbox_full', `Too many files named ${wanted}`, 409);
  }

  private publish(msg: Message): void {
    const live: LiveMessage = {
      type: 'message.created',
      threadId: msg.threadId,
      messageId: msg.id,
      runId: msg.runId,
      authorBotId: msg.authorBotId,
      contentMd: msg.contentMd,
      authorType: msg.authorType,
      createdAt: msg.createdAt,
    };
    this.opts.bus.publish(`thread:${msg.threadId}`, live);
  }
}
