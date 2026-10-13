import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Bot, Message, Repos, Run, Thread } from '@agenta/db';
import {
  INBOX_DIR,
  type InboxUploadResponse,
  type LiveMessage,
  type LiveThreadActivity,
  type RetryTurnRequest,
  type ThreadUpdateRequest,
  type UnreadCounts,
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
  nowIso,
  sendMessageRequestSchema,
  threadUpdateRequestSchema,
} from '@agenta/shared';
import type { BotService } from '../bots/service';
import type { EventBus } from '../bus';
import { botHomeDir } from '../containers/home';
import { buildPrompt, toPromptMessages } from '../engines/prompt';
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
  runs: { enqueue(input: Parameters<RunService['enqueue']>[0]): Run };
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
    const thread = this.writable(id);
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
    // What the bot reads for this message: the text plus the attachments' full paths in its computer.
    const forBot = { ...message, contentMd: composeUserPrompt(req.content, req.attachments) };
    const runs: Run[] = [];
    for (const bot of recipients) {
      const prompt = this.promptFor(bot, thread, forBot);
      const run = this.opts.runs.enqueue({ botId: bot.id, threadId: id, trigger: 'user', prompt });
      runs.push(run);
      this.markSeen(run, message.id);
    }
    const stored = runs[0] ? (repos.messages.setRunId(message.id, runs[0].id) ?? message) : message;
    this.publish(stored);
    log.info({ threadId: id, messageId: message.id, runs: runs.map((r) => r.id) }, 'message posted');
    return { message: toMessageView(stored), runs: runs.map(toRunView) };
  }

  /** The bot has now seen everything up to this message. */
  private markSeen(run: Run, messageId: string): void {
    // Keep the stored engine: a session id from the bot's previous engine must never be resumed by another one.
    const session = this.opts.repos.sessions.get(run.botId, run.threadId!);
    this.opts.repos.sessions.upsert({
      botId: run.botId,
      threadId: run.threadId!,
      engine: session?.engine ?? run.engine,
      lastSeenMessageId: messageId,
    });
  }

  private writable(id: string): Thread {
    const thread = this.thread(id);
    if (thread.archivedAt) throw new ThreadError('thread_archived', 'This conversation is archived', 409);
    return thread;
  }

  /** A bot's own message in a thread it belongs to (Platform MCP `post_message`). Starts no runs (routing: F18). */
  postAsBot(bot: Bot, threadId: string, text: string): MessageView {
    this.writable(threadId);
    if (!this.opts.repos.threads.isMember(threadId, bot.id)) {
      throw new ThreadError('not_a_member', `You are not a member of thread ${threadId}`, 403);
    }
    const message = this.opts.repos.messages.create({
      threadId,
      authorType: 'bot',
      authorBotId: bot.id,
      contentMd: text,
    });
    this.publish(message);
    this.opts.log.info({ threadId, messageId: message.id, botId: bot.id }, 'bot posted');
    return toMessageView(message);
  }

  /**
   * Platform MCP `ask_bot`: `from` posts `text` (mentioning the target) in a thread the target is in, by default the
   * target's DM with the owner, and the target gets a `delegation` run one hop further than the asking run.
   * Returns at once; the asker follows up with get_run_status.
   */
  askBot(
    from: Bot,
    target: Bot,
    text: string,
    opts: { threadId?: string; parentRun?: Run } = {},
  ): { message: MessageView; run: RunView } {
    const { repos } = this.opts;
    if (target.id === from.id) throw new ThreadError('ask_self', 'You cannot ask yourself', 400);
    if (target.archivedAt) throw new ThreadError('bot_archived', `${target.name} is archived`, 409);
    const threadId = opts.threadId ?? repos.threads.findDm(target.id)?.id;
    if (!threadId)
      throw new ThreadError('thread_not_found', `${target.name} has no direct-message thread`, 404);
    const thread = this.writable(threadId);
    if (!repos.threads.isMember(threadId, target.id)) {
      throw new ThreadError('not_a_member', `${target.name} is not in thread ${threadId}`, 400);
    }
    // Owner DMs are open to teammates (that is where the owner watches a bot's work); other threads are not.
    if (thread.kind !== 'dm' && !repos.threads.isMember(threadId, from.id)) {
      throw new ThreadError('not_a_member', `You are not a member of thread ${threadId}`, 403);
    }
    const message = repos.messages.create({
      threadId,
      authorType: 'bot',
      authorBotId: from.id,
      contentMd: text,
      mentions: [target.id],
    });
    const run = this.opts.runs.enqueue({
      botId: target.id,
      threadId,
      trigger: 'delegation',
      prompt: this.promptFor(target, thread, message),
      parentRunId: opts.parentRun?.id ?? null,
      hopCount: (opts.parentRun?.hopCount ?? 0) + 1,
    });
    this.markSeen(run, message.id);
    this.publish(message);
    this.opts.log.info({ threadId, messageId: message.id, from: from.id, runId: run.id }, 'bot asked');
    return { message: toMessageView(message), run: toRunView(run) };
  }

  /**
   * The turn prompt (engines/prompt.ts): a plain DM message as typed, or, with Explain mode on or unseen messages
   * from others, the messages since the bot's last turn plus the mode's instructions. The bot's own replies are
   * already in its engine session, so they are left out; a bot with no recorded turn only gets the new message.
   */
  private promptFor(bot: Bot, thread: Thread, latest: Message): string {
    const { repos } = this.opts;
    const seen = repos.sessions.get(bot.id, thread.id)?.lastSeenMessageId ?? null;
    const unseen = seen
      ? repos.messages
          .listSince(thread.id, seen)
          .filter((m) => m.id !== latest.id && m.authorBotId !== bot.id)
      : [];
    // Every bot, not just members: teammates can write in a bot's DM through ask_bot.
    const members = new Map(repos.bots.list({ includeArchived: true }).map((b) => [b.id, b]));
    return buildPrompt({ bot, thread, newMessages: toPromptMessages([...unseen, latest], members) });
  }

  /** Rename, or toggle Explain mode (read by the prompt builder on the bots' next turns). */
  update(id: string, body: ThreadUpdateRequest): ThreadView {
    this.thread(id);
    this.opts.repos.threads.update(id, threadUpdateRequestSchema.parse(body));
    return this.get(id);
  }

  /**
   * Runs a finished turn again with the same prompt. Only the bot's latest turn in the thread can be retried; the
   * new run links to the original turn (`retry_of_run_id`) so the chat shows it under the same user message.
   */
  retry(id: string, body: RetryTurnRequest): RunView {
    const { repos } = this.opts;
    const thread = this.thread(id);
    if (thread.archivedAt) throw new ThreadError('thread_archived', 'This conversation is archived', 409);
    const run = repos.runs.get(body.runId);
    if (!run || run.threadId !== id) {
      throw new ThreadError('run_not_found', `Run ${body.runId} is not in this thread`, 404);
    }
    if (run.status === 'queued' || run.status === 'running') {
      throw new ThreadError('run_active', 'This turn is still in progress', 409);
    }
    const latest = repos.runs.list({ threadId: id, botId: run.botId, limit: 1 })[0];
    if (latest?.id !== run.id) {
      throw new ThreadError('not_last_turn', 'Only the latest turn can be retried', 409);
    }
    const retry = this.opts.runs.enqueue({
      botId: run.botId,
      threadId: id,
      trigger: run.trigger,
      prompt: run.prompt,
      retryOfRunId: run.retryOfRunId ?? run.id,
    });
    this.opts.log.info({ threadId: id, runId: retry.id, of: run.id }, 'turn retried');
    return toRunView(retry);
  }

  /** The owner has seen the thread up to now. */
  markRead(id: string): { lastReadAt: string } {
    const thread = this.thread(id);
    const at = nowIso();
    const updated = this.opts.repos.threads.markRead(id, at);
    return { lastReadAt: updated?.lastReadAt ?? thread.lastReadAt ?? at };
  }

  unread(): UnreadCounts {
    return { counts: this.opts.repos.threads.unreadCounts() };
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
    const activity: LiveThreadActivity = {
      type: 'thread.activity',
      threadId: msg.threadId,
      messageId: msg.id,
      authorType: msg.authorType,
    };
    this.opts.bus.publish('global', activity);
  }
}
