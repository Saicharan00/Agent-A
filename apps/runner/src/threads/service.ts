import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Bot, Message, Repos, Run, Thread } from '@agenta/db';
import {
  INBOX_DIR,
  type AddMemberRequest,
  type GroupCreateRequest,
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
  addMemberRequestSchema,
  composeUserMessage,
  composeUserPrompt,
  groupCreateRequestSchema,
  parseMentions,
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
import { buildPrompt, renderFollowUp, toPromptMessages } from '../engines/prompt';
import { toPromptGoal } from '../goals/service';
import type { RunService } from '../runs/service';

/** Bot-triggered turns allowed in a chain started by one owner message (PLAN F18 loop guard). */
export const MAX_HOPS = 6;
/** settings key overriding MAX_HOPS (a positive integer). */
export const MAX_HOPS_SETTING = 'maxHopsPerMessage';
/** A bot triggered again in the same thread this soon, while its turn is still queued, gets one merged turn. */
export const TRIGGER_DEBOUNCE_MS = 5_000;

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
  runs: Pick<RunService, 'enqueue' | 'cancel' | 'admitGoal'>;
  now?: () => Date;
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
 * Chats (PLAN F13, F18): reading a thread's history and posting messages. Posting writes the message, publishes it
 * on `thread:<id>` and queues one run per addressed bot: in a DM the DM's bot; in a group the @mentioned members,
 * or the moderator when nobody is mentioned. Bot messages in a group that @mention another member start that
 * member's turn, one hop further, up to MAX_HOPS.
 */
export class ThreadService {
  constructor(private readonly opts: ThreadServiceOptions) {}

  private thread(id: string) {
    const thread = this.opts.repos.threads.get(id);
    if (!thread) throw new ThreadError('thread_not_found', `Thread ${id} not found`, 404);
    return thread;
  }

  get(id: string): ThreadView {
    return this.view(this.thread(id));
  }

  private view(thread: Thread, activity = this.opts.repos.runs.lastActivityByBot()): ThreadView {
    return {
      ...thread,
      members: this.opts.repos.threads.listMembers(thread.id).map((b) => this.opts.bots.view(b, activity)),
    };
  }

  /** Non-archived threads, most recently active first (the sidebar's group list uses kind=group). */
  list(kind?: Thread['kind']): ThreadView[] {
    const activity = this.opts.repos.runs.lastActivityByBot();
    return this.opts.repos.threads.list({ kind }).map((t) => this.view(t, activity));
  }

  createGroup(body: GroupCreateRequest): ThreadView {
    const { repos } = this.opts;
    const req = groupCreateRequestSchema.parse(body);
    for (const botId of req.memberBotIds) this.activeBot(botId);
    if (req.moderatorBotId && !req.memberBotIds.includes(req.moderatorBotId)) {
      throw new ThreadError('moderator_not_member', 'The moderator must be a member of the group', 400);
    }
    const thread = repos.threads.create({ kind: 'group', ...req });
    this.opts.log.info({ threadId: thread.id, members: req.memberBotIds.length }, 'group created');
    return this.get(thread.id);
  }

  addMember(id: string, body: AddMemberRequest): ThreadView {
    const thread = this.group(id);
    const bot = this.activeBot(addMemberRequestSchema.parse(body).botId);
    if (this.opts.repos.threads.addMember(thread.id, bot.id)) {
      this.systemMessage(thread.id, `${bot.name} joined the group.`);
    }
    return this.get(id);
  }

  removeMember(id: string, botId: string): ThreadView {
    const { repos } = this.opts;
    const thread = this.group(id);
    const bot = repos.bots.get(botId);
    if (!bot || !repos.threads.isMember(id, botId)) {
      throw new ThreadError('not_a_member', `Bot ${botId} is not in this group`, 404);
    }
    if (repos.threads.listMembers(id).length <= 1) {
      throw new ThreadError('last_member', 'A group needs at least one member', 409);
    }
    repos.threads.removeMember(id, botId);
    if (thread.moderatorBotId === botId) repos.threads.update(id, { moderatorBotId: null });
    this.systemMessage(id, `${bot.name} left the group.`);
    return this.get(id);
  }

  private group(id: string): Thread {
    const thread = this.writable(id);
    if (thread.kind !== 'group')
      throw new ThreadError('not_a_group', 'Only group chats have editable members', 409);
    return thread;
  }

  private activeBot(botId: string): Bot {
    const bot = this.opts.repos.bots.get(botId);
    if (!bot) throw new ThreadError('bot_not_found', `Bot ${botId} not found`, 404);
    if (bot.archivedAt) throw new ThreadError('bot_archived', `${bot.name} is archived`, 409);
    return bot;
  }

  private systemMessage(threadId: string, text: string): void {
    this.publish(this.opts.repos.messages.create({ threadId, authorType: 'system', contentMd: text }));
  }

  /** Who answers group messages without mentions: the configured moderator, else Agent A, else the first member. */
  moderatorOf(thread: Thread, members: Bot[]): Bot | undefined {
    const active = members.filter((b) => !b.archivedAt);
    return active.find((b) => b.id === thread.moderatorBotId) ?? active.find((b) => b.isLead) ?? active[0];
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

  /** The bots a new owner message is addressed to, and the members it mentions. */
  private recipients(thread: Thread, content: string): { bots: Bot[]; mentions: string[] } {
    const members = this.opts.repos.threads.listMembers(thread.id);
    // A goal thread is the owner's conversation with the lead about the goal (F20).
    if (thread.kind === 'dm' || thread.kind === 'goal') return { bots: members, mentions: [] };
    if (thread.kind !== 'group') return { bots: [], mentions: [] };
    const mentions = parseMentions(content, members);
    if (mentions.length > 0) {
      return { bots: mentions.map((id) => members.find((b) => b.id === id)!), mentions };
    }
    const moderator = this.moderatorOf(thread, members);
    return { bots: moderator ? [moderator] : [], mentions };
  }

  send(id: string, body: SendMessageRequest): SendMessageResponse {
    const { repos, log } = this.opts;
    const thread = this.writable(id);
    const req = sendMessageRequestSchema.parse(body);
    const { bots: recipients, mentions } = this.recipients(thread, req.content);
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

    // A paused goal or one out of runs refuses before the message is posted.
    if (thread.kind === 'goal') this.opts.runs.admitGoal({ threadId: id });
    if (thread.pausedAt) {
      repos.threads.setPaused(id, null);
      log.info({ threadId: id }, 'group resumed by a new message');
    }
    const message = repos.messages.create({
      threadId: id,
      authorType: 'user',
      contentMd: composeUserMessage(req.content, req.attachments),
      mentions,
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

  /**
   * The owner asks the lead (Agent A) something in `threadId` (default: the lead's DM), even in a thread the lead is
   * not a member of: the message is posted as the owner's and only the lead gets a turn. Used by "Ask Agent A why",
   * the weekly review and carry-over briefs (F23).
   */
  askLead(threadId: string | null, content: string): SendMessageResponse {
    const { repos, log } = this.opts;
    const lead = repos.bots.getLead();
    if (!lead) throw new ThreadError('no_lead', 'There is no lead bot (Agent A) on the team', 409);
    const id = threadId ?? repos.threads.findDm(lead.id)?.id;
    if (!id) throw new ThreadError('thread_not_found', `${lead.name} has no direct messages thread`, 404);
    const thread = this.writable(id);
    if (thread.kind === 'goal') this.opts.runs.admitGoal({ threadId: id });
    const message = repos.messages.create({
      threadId: id,
      authorType: 'user',
      contentMd: content,
      mentions: thread.kind === 'group' ? [lead.id] : [],
    });
    const run = this.opts.runs.enqueue({
      botId: lead.id,
      threadId: id,
      trigger: 'user',
      prompt: this.promptFor(lead, thread, message),
    });
    this.markSeen(run, message.id);
    const stored = repos.messages.setRunId(message.id, run.id) ?? message;
    this.publish(stored);
    log.info({ threadId: id, messageId: message.id, runId: run.id }, 'lead asked');
    return { message: toMessageView(stored), runs: [toRunView(run)] };
  }

  /** "Ask Agent A why" on a bot's message: the lead explains the reasoning behind it in the same thread. */
  askWhy(threadId: string, messageId: string): SendMessageResponse {
    const { repos } = this.opts;
    const msg = repos.messages.get(messageId);
    if (!msg || msg.threadId !== threadId || msg.authorType !== 'bot') {
      throw new ThreadError('message_not_found', `Bot message ${messageId} is not in this thread`, 404);
    }
    const author = msg.authorBotId ? repos.bots.get(msg.authorBotId) : undefined;
    const lead = repos.bots.getLead();
    const who = author && author.id === lead?.id ? 'your' : `${author?.name ?? 'a teammate'}'s`;
    const quoted = clipText(msg.contentMd.trim(), 4_000).replace(/^/gm, '> ');
    return this.askLead(
      threadId,
      `Why? Explain the reasoning behind ${who} message below: the principle it follows, the trade-offs, ` +
        `and what a lead would check. Keep it short.\n\n${quoted}`,
    );
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

  /** A bot's own message in a thread it belongs to (Platform MCP `post_message`); its @mentions are routed. */
  postAsBot(bot: Bot, threadId: string, text: string, parentRun?: Run): MessageView {
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
    const routed = this.routeBotMessage(message, parentRun) ?? message;
    this.publish(routed);
    this.opts.log.info({ threadId, messageId: message.id, botId: bot.id }, 'bot posted');
    return toMessageView(routed);
  }

  /**
   * A bot's message in a group (its reply or a post): every other member it @mentions gets a `mention` run one hop
   * further than `parentRun` (merged into a just-queued turn, see `trigger`). Past the hop limit or while the group
   * is paused nobody is triggered. Records the mentions on the message and returns it
   * (undefined when nothing changed). The caller publishes the message.
   */
  routeBotMessage(message: Message, parentRun?: Run): Message | undefined {
    const { repos, log } = this.opts;
    const thread = repos.threads.get(message.threadId);
    if (!thread || thread.kind !== 'group' || thread.archivedAt || message.authorType !== 'bot') return;
    const members = repos.threads.listMembers(thread.id).filter((b) => !b.archivedAt);
    const mentions = parseMentions(message.contentMd, members).filter((id) => id !== message.authorBotId);
    if (mentions.length === 0) return;
    const stored = repos.messages.setMentions(message.id, mentions) ?? message;
    if (thread.pausedAt) {
      log.info({ threadId: thread.id, messageId: message.id }, 'mention not routed: group paused');
      return stored;
    }
    const hopCount = (parentRun?.hopCount ?? 0) + 1;
    if (this.overHopLimit(thread.id, hopCount)) return stored;
    for (const id of mentions) {
      const bot = members.find((b) => b.id === id)!;
      this.trigger(bot, thread, stored, { trigger: 'mention', parentRun, hopCount });
    }
    log.info({ threadId: thread.id, messageId: message.id, mentions }, 'bot mentions routed');
    return stored;
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
    if (thread.pausedAt) {
      throw new ThreadError('group_paused', 'The owner paused this group; wait until they write again', 409);
    }
    const hopCount = (opts.parentRun?.hopCount ?? 0) + 1;
    if (this.overHopLimit(threadId, hopCount)) {
      throw new ThreadError(
        'hop_limit',
        `Too many bot-to-bot turns for one owner message (limit ${this.maxHops()}); wait for the owner`,
        409,
      );
    }
    const message = repos.messages.create({
      threadId,
      authorType: 'bot',
      authorBotId: from.id,
      contentMd: text,
      mentions: [target.id],
    });
    const run = this.trigger(target, thread, message, {
      trigger: 'delegation',
      parentRun: opts.parentRun,
      hopCount,
    });
    this.publish(message);
    this.opts.log.info({ threadId, messageId: message.id, from: from.id, runId: run.id }, 'bot asked');
    return { message: toMessageView(message), run: toRunView(run) };
  }

  private maxHops(): number {
    const v = this.opts.repos.settings.get<unknown>(MAX_HOPS_SETTING);
    return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : MAX_HOPS;
  }

  /** True (and the owner is told in the thread) when a bot-triggered turn would pass the hop limit. */
  private overHopLimit(threadId: string, hopCount: number): boolean {
    const max = this.maxHops();
    if (hopCount <= max) return false;
    this.opts.log.info({ threadId, hopCount }, 'bot trigger stopped: hop limit');
    this.systemMessage(
      threadId,
      `Stopped: the bots reached the limit of ${max} bot-to-bot turns for one message. Write here to continue.`,
    );
    return true;
  }

  /**
   * Starts a bot-triggered turn, or merges it into the bot's turn in this thread that was queued in the last
   * TRIGGER_DEBOUNCE_MS (its prompt gains the new message), so a burst of mentions becomes one turn.
   */
  private trigger(
    bot: Bot,
    thread: Thread,
    message: Message,
    t: { trigger: 'mention' | 'delegation'; parentRun?: Run; hopCount: number },
  ): Run {
    const { repos } = this.opts;
    const now = (this.opts.now?.() ?? new Date()).getTime();
    const queued = repos.runs.list({ botId: bot.id, threadId: thread.id, status: 'queued', limit: 1 })[0];
    if (
      queued &&
      (queued.trigger === 'mention' || queued.trigger === 'delegation') &&
      now - Date.parse(queued.createdAt) <= TRIGGER_DEBOUNCE_MS
    ) {
      const everyone = new Map(repos.bots.list({ includeArchived: true }).map((b) => [b.id, b]));
      const extra = renderFollowUp(bot, toPromptMessages([message], everyone));
      const merged = repos.runs.updateQueuedPrompt(queued.id, `${queued.prompt}\n\n${extra}`);
      if (merged) {
        this.markSeen(merged, message.id);
        this.opts.log.info(
          { threadId: thread.id, runId: merged.id, messageId: message.id },
          'trigger merged',
        );
        return merged;
      }
    }
    const run = this.opts.runs.enqueue({
      botId: bot.id,
      threadId: thread.id,
      trigger: t.trigger,
      prompt: this.promptFor(bot, thread, message),
      parentRunId: t.parentRun?.id ?? null,
      hopCount: t.hopCount,
    });
    this.markSeen(run, message.id);
    return run;
  }

  /** "Pause group": cancels the thread's queued turns; bot mentions start nothing until the owner writes or resumes. */
  async pause(id: string): Promise<ThreadView> {
    const { repos } = this.opts;
    this.group(id);
    repos.threads.setPaused(id, nowIso());
    const queued = repos.runs.list({ threadId: id, status: 'queued', limit: 500 });
    let cancelled = 0;
    for (const run of queued) {
      try {
        await this.opts.runs.cancel(run.id);
        cancelled++;
      } catch {
        // It started or finished meanwhile: nothing to cancel.
      }
    }
    this.systemMessage(
      id,
      `Paused by the owner${cancelled ? `: ${cancelled} queued turn${cancelled === 1 ? '' : 's'} cancelled` : ''}. Bots start no new turns here until you write again.`,
    );
    this.opts.log.info({ threadId: id, cancelled }, 'group paused');
    return this.get(id);
  }

  resume(id: string): ThreadView {
    const thread = this.group(id);
    if (thread.pausedAt) {
      this.opts.repos.threads.setPaused(id, null);
      this.systemMessage(id, 'Resumed by the owner.');
    }
    return this.get(id);
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
    const everyone = new Map(repos.bots.list({ includeArchived: true }).map((b) => [b.id, b]));
    const newMessages = toPromptMessages([...unseen, latest], everyone);
    if (thread.kind === 'goal') {
      const goal = repos.goals.getByThread(thread.id);
      return buildPrompt({ bot, thread, newMessages, goal: goal && toPromptGoal(repos, goal) });
    }
    if (thread.kind !== 'group') return buildPrompt({ bot, thread, newMessages });
    const members = repos.threads.listMembers(thread.id).filter((b) => !b.archivedAt);
    const group = {
      purpose: thread.purpose,
      members,
      moderatorId: this.moderatorOf(thread, members)?.id ?? null,
    };
    return buildPrompt({ bot, thread, newMessages, group });
  }

  /** Rename, or toggle Explain mode (read by the prompt builder on the bots' next turns). */
  update(id: string, body: ThreadUpdateRequest): ThreadView {
    const thread = this.thread(id);
    const patch = threadUpdateRequestSchema.parse(body);
    if (patch.moderatorBotId !== undefined || patch.purpose !== undefined) {
      if (thread.kind !== 'group')
        throw new ThreadError('not_a_group', 'Only group chats have a moderator and purpose', 409);
    }
    if (patch.moderatorBotId && !this.opts.repos.threads.isMember(id, patch.moderatorBotId)) {
      throw new ThreadError('moderator_not_member', 'The moderator must be a member of the group', 400);
    }
    this.opts.repos.threads.update(id, patch);
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

  /** Announces a new message on `thread:<id>` and as global thread activity. */
  publish(msg: Message): void {
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

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (truncated)` : s);
