import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, Message, Task, Thread } from '@agenta/db';

// Turns platform state into what an engine reads: the per-turn prompt, a system-prompt addition, and the
// instruction files the CLIs load on their own (/home/bot/CLAUDE.md for Claude Code, AGENTS.md for Codex).
// Pure functions over plain data so they can be snapshot-tested.

export type PromptMessage = {
  authorType: Message['authorType'];
  authorName: string;
  contentMd: string;
  createdAt: string;
  mentions: string[];
};

export type PromptBot = Pick<Bot, 'id' | 'name' | 'slug' | 'role'>;
export type PromptThread = Pick<Thread, 'id' | 'kind' | 'title' | 'explainMode'>;
export type PromptTask = Pick<
  Task,
  'id' | 'title' | 'status' | 'priority' | 'descriptionMd' | 'acceptanceMd' | 'revisionCount'
>;

export type PromptGroup = {
  purpose: string;
  members: Pick<Bot, 'id' | 'name' | 'slug' | 'role' | 'isLead'>[];
  /** Who answers messages that mention nobody. */
  moderatorId: string | null;
};

export type BuildPromptInput = {
  bot: PromptBot;
  thread: PromptThread;
  /** Messages since this bot's last turn, oldest first. */
  newMessages: PromptMessage[];
  task?: PromptTask | null;
  /** Defaults to the thread's explain-mode flag. */
  explainMode?: boolean;
  /** Group chats: purpose and members (F18). */
  group?: PromptGroup | null;
};

function renderGroup(g: PromptGroup, thread: PromptThread, bot: PromptBot): string {
  const lines = [`## About #${thread.title}`];
  if (g.purpose.trim()) lines.push(`Purpose: ${g.purpose.trim()}`);
  lines.push(
    'Members:',
    ...g.members.map((m) => {
      const tags = [
        m.isLead ? 'lead' : '',
        m.id === g.moderatorId ? 'moderator' : '',
        m.id === bot.id ? 'you' : '',
      ]
        .filter(Boolean)
        .join(', ');
      return `- ${m.name} (@${m.slug})${m.role ? `: ${m.role}` : ''}${tags ? ` [${tags}]` : ''}`;
    }),
  );
  if (g.moderatorId === bot.id) {
    lines.push(
      '',
      'You moderate this group: messages that mention nobody come to you. Answer them yourself, or bring in the right teammates by @mentioning them in your reply or with `ask_bot`.',
    );
  }
  lines.push('', "Write @owner when you need the owner's attention.");
  return lines.join('\n');
}

/** Maps DB messages to prompt messages, resolving author names. */
export function toPromptMessages(
  messages: Message[],
  botsById: Map<string, Pick<Bot, 'name'>>,
  ownerName = 'Owner',
): PromptMessage[] {
  return messages.map((m) => ({
    authorType: m.authorType,
    authorName:
      m.authorType === 'user'
        ? ownerName
        : m.authorType === 'system'
          ? 'System'
          : (botsById.get(m.authorBotId ?? '')?.name ?? 'A former teammate'),
    contentMd: m.contentMd,
    createdAt: m.createdAt,
    mentions: m.mentions,
  }));
}

const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

function renderMessage(m: PromptMessage, bot: PromptBot): string {
  const who = m.authorType === 'bot' ? `${m.authorName} (bot)` : m.authorName;
  const tag = m.mentions.includes(bot.id) ? ' (mentions you)' : '';
  return `**${who}** · ${minute(m.createdAt)}${tag}:\n${m.contentMd.trim()}`;
}

function renderTask(t: PromptTask): string {
  const lines = [
    `## Task ${t.id}: ${t.title}`,
    `Status: ${t.status} · Priority: ${t.priority}${t.revisionCount > 0 ? ` · Revision ${t.revisionCount}` : ''}`,
  ];
  if (t.descriptionMd.trim()) lines.push('', '### Description', t.descriptionMd.trim());
  if (t.acceptanceMd.trim()) lines.push('', '### Acceptance criteria', t.acceptanceMd.trim());
  return lines.join('\n');
}

export const EXPLAIN_MODE_TEXT = `## Explain mode is on
The owner is learning from you. Alongside doing the work:
- Before acting, say in one or two sentences what you are about to do and why.
- Name the trade-offs you considered and why you picked this option.
- Afterwards, list the key takeaways a strong engineer would remember from this turn.`;

/** What is appended to a queued turn's prompt when another trigger for the same bot is merged into it. */
export function renderFollowUp(bot: PromptBot, messages: PromptMessage[]): string {
  return [
    '## Also new since this turn was queued',
    messages.map((m) => renderMessage(m, bot)).join('\n\n'),
  ].join('\n\n');
}

/** The text sent to the engine for one turn. */
export function buildPrompt(input: BuildPromptInput): string {
  const { bot, thread, newMessages, task } = input;
  const explain = input.explainMode ?? thread.explainMode;
  const simple =
    thread.kind === 'dm' &&
    !task &&
    !explain &&
    newMessages.length === 1 &&
    newMessages[0]!.authorType === 'user';
  // A plain DM turn is just the owner's message, like typing into the CLI.
  if (simple) return newMessages[0]!.contentMd.trim();

  const parts: string[] = [];
  if (input.group) parts.push(renderGroup(input.group, thread, bot));
  if (newMessages.length > 0) {
    const where =
      thread.kind === 'dm'
        ? 'this chat'
        : thread.kind === 'group'
          ? `#${thread.title}`
          : `the ${thread.kind} thread "${thread.title}"`;
    parts.push(
      `## New messages in ${where} since your last turn`,
      newMessages.map((m) => renderMessage(m, bot)).join('\n\n'),
    );
  }
  if (task) parts.push(renderTask(task));
  if (explain) parts.push(EXPLAIN_MODE_TEXT);
  if (task) parts.push('Work on the task above and report what you did.');
  if (thread.kind !== 'dm') {
    parts.push(
      `Reply as ${bot.name}. Others only see your final message in the thread; mention a teammate with @slug only when you need them.`,
    );
  }
  return parts.join('\n\n');
}

/** Short identity + platform rules appended to the engine's system prompt. */
export function buildSystemPromptAppend(bot: PromptBot, thread: PromptThread | null): string {
  return [
    `You are ${bot.name}${bot.role ? `, ${bot.role}` : ''}: one of the AI teammates on the owner's Agent A team (handle @${bot.slug}).`,
    thread ? `You are working in thread ${thread.id} (${thread.kind}).` : '',
    'Your computer is a Linux container: work in /home/bot/work, keep notes in /home/bot/notes, team files are in /shared.',
    'Use the `agenta` MCP tools to create tasks, message teammates, record decisions and request approval for risky external actions.',
  ]
    .filter(Boolean)
    .join('\n');
}

export type InstructionMemory = { title: string; contentMd: string; scope: 'bot' | 'shared' };

export type InstructionFiles = { 'CLAUDE.md': string; 'AGENTS.md': string };

/**
 * Renders /home/bot/CLAUDE.md and AGENTS.md from the bot's instructions and memory (memory is a stub until F22:
 * callers pass none yet). Both engines get the same content.
 */
export function renderInstructionFiles(
  bot: Pick<Bot, 'name' | 'role' | 'instructions' | 'isLead'>,
  memories: InstructionMemory[] = [],
): InstructionFiles {
  const own = memories.filter((m) => m.scope === 'bot');
  const shared = memories.filter((m) => m.scope === 'shared');
  const mem = (list: InstructionMemory[]) =>
    list.length ? list.map((m) => `### ${m.title}\n${m.contentMd.trim()}`).join('\n\n') : '_Nothing yet._';
  const body = [
    `# ${bot.name}`,
    `<!-- Rendered by Agent A before each run from the bot's settings and memory. Edits here are overwritten. -->`,
    bot.role
      ? `**Role:** ${bot.role}${bot.isLead ? ' (team lead)' : ''}`
      : bot.isLead
        ? '**Role:** team lead'
        : '',
    '## Instructions',
    bot.instructions.trim() || '_No custom instructions._',
    '## Your computer',
    [
      '- `/home/bot/work`: your working directory (persists between runs).',
      '- `/home/bot/notes`: your own notes; write down anything worth remembering.',
      '- `/shared`: files shared with the whole team; `/shared/knowledge` holds team knowledge.',
      '- A desktop (DISPLAY=:99) with Chromium. Use the Playwright MCP browser for web tasks; the owner can watch it live. Your browser profile (`/home/bot/.browser-profile`) keeps sign-ins between runs.',
    ].join('\n'),
    '## Your team',
    [
      'The `agenta` MCP tools connect you to the team and the owner: `whoami`, `list_bots`, `ask_bot` (a teammate',
      'starts working; follow up with `get_run_status`), threads, tasks (`create_task`, `update_task`,',
      '`submit_task_result`), memory, decisions, lessons, `request_approval` before risky actions, `notify_owner`.',
      bot.isLead
        ? 'As the lead you assign tasks to others and review handed-in work with `review_task`.'
        : 'Only the lead assigns work to others; ask teammates for help with `ask_bot`.',
    ].join(' '),
    '## Memory',
    mem(own),
    '## Team knowledge',
    mem(shared),
  ].filter(Boolean);
  const text = `${body.join('\n\n')}\n`;
  return { 'CLAUDE.md': text, 'AGENTS.md': text };
}

/** Writes the rendered files into the bot's home on the host (atomic replace). */
export function writeInstructionFiles(home: string, files: InstructionFiles): void {
  mkdirSync(home, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(home, name);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }
}
