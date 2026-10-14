import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bot, Goal, Message, Task, Thread } from '@agenta/db';
import { MAX_REVISION_ROUNDS, goalArtifactsDir } from '@agenta/shared';

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

export type PromptGoal = Pick<
  Goal,
  'id' | 'title' | 'slug' | 'goalMd' | 'constraintsMd' | 'autoRun' | 'confirmedAt' | 'maxTasks'
> & { tasksTotal: number; tasksDone: number };

/** A handed-in task for the lead to review (F20). */
export type PromptReview = PromptTask & {
  assigneeName: string;
  resultSummaryMd: string | null;
  artifacts: string[];
};

/** The goal's tasks when the lead writes the goal report (F20). */
export type PromptReportTask = Pick<Task, 'id' | 'title' | 'resultSummaryMd' | 'artifacts' | 'executedBy'> & {
  assigneeName: string;
};

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
  /** Goal threads (the lead's turns) and goal task briefs (F20). */
  goal?: PromptGoal | null;
  /** A review turn of the lead: the handed-in task. */
  review?: PromptReview | null;
  /** The lead's goal report turn: every task is done. */
  report?: PromptReportTask[] | null;
};

/** The goal as the lead sees it in its goal thread, with what to do next. */
function renderGoal(g: PromptGoal): string {
  const lines = [`## Goal ${g.id}: ${g.title}`, g.goalMd.trim()];
  if (g.constraintsMd.trim()) lines.push('', '### Constraints', g.constraintsMd.trim());
  lines.push('', `Artifacts folder for this goal: \`${goalArtifactsDir(g.slug)}\``);
  if (g.tasksTotal > 0) {
    lines.push(`Progress: ${g.tasksDone}/${g.tasksTotal} tasks done.`);
  } else if (g.confirmedAt || g.autoRun) {
    lines.push(
      `Plan status: ${g.confirmedAt ? 'the owner confirmed the plan' : 'auto-run is on'}. Create the tasks now with \`create_task\` (at most ${g.maxTasks}).`,
    );
  } else {
    lines.push(
      'Plan status: waiting for the owner. Propose the plan (or answer the owner) and ask them to confirm it; do not create tasks yet.',
    );
  }
  return lines.join('\n');
}

/** What a specialist needs to know about the goal behind its task. */
function renderGoalContext(g: PromptGoal): string {
  const goal = g.goalMd.trim();
  const lines = [`### Goal context: ${g.title}`, goal.length > 2000 ? `${goal.slice(0, 2000)}…` : goal];
  if (g.constraintsMd.trim()) lines.push('', 'Constraints:', g.constraintsMd.trim());
  lines.push('', `Put your artifacts in \`${goalArtifactsDir(g.slug)}\` (create it if it is missing).`);
  return lines.join('\n');
}

function renderReview(r: PromptReview): string {
  const lines = [
    `## Review: task ${r.id}: ${r.title}`,
    `Handed in by ${r.assigneeName} · Revision: ${r.revisionCount}`,
  ];
  if (r.acceptanceMd.trim()) lines.push('', '### Acceptance criteria', r.acceptanceMd.trim());
  lines.push('', '### Result summary', r.resultSummaryMd?.trim() || '_No summary._');
  lines.push(
    '',
    '### Artifacts',
    r.artifacts.length ? r.artifacts.map((a) => `- ${a}`).join('\n') : '_None._',
  );
  lines.push(
    '',
    `Check the work against the acceptance criteria (open the artifacts; they are on your computer too). Then call \`review_task\` (id ${r.id}): approve, or request_changes with concrete, actionable feedback. After ${MAX_REVISION_ROUNDS} rounds of changes the owner decides instead.`,
  );
  return lines.join('\n');
}

function renderReport(tasks: PromptReportTask[]): string {
  return [
    `## Goal report: all ${tasks.length} tasks are done`,
    tasks
      .map(
        (t) =>
          `- ${t.title} (${t.id}, ${t.executedBy === 'human' ? 'done by the owner' : t.assigneeName}): ${t.resultSummaryMd?.trim() || 'no summary'}${t.artifacts.length ? ` · artifacts: ${t.artifacts.join(', ')}` : ''}`,
      )
      .join('\n'),
    '',
    [
      'Write the goal report as your reply here, with these sections: what was done; decisions made (record each',
      'with `record_decision`); risks and open questions; what the owner should do themselves; and 1–3 lessons',
      '(add each with `add_lesson`).',
    ].join(' '),
  ].join('\n');
}

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

function renderTask(t: PromptTask, goal?: PromptGoal | null): string {
  const lines = [
    `## Task ${t.id}: ${t.title}`,
    `Status: ${t.status} · Priority: ${t.priority}${t.revisionCount > 0 ? ` · Revision ${t.revisionCount}` : ''}`,
  ];
  if (t.descriptionMd.trim()) lines.push('', '### Description', t.descriptionMd.trim());
  if (t.acceptanceMd.trim()) lines.push('', '### Acceptance criteria', t.acceptanceMd.trim());
  if (goal) lines.push('', renderGoalContext(goal));
  return lines.join('\n');
}

/** The four sections every answer ends with while Explain mode is on (PLAN F23). */
export const EXPLAIN_SECTIONS = [
  'Why this approach',
  'Trade-offs considered',
  'What a lead would watch for',
  'Lesson',
] as const;

export const EXPLAIN_MODE_TEXT = `## Explain mode is on
The owner is learning from you, so teach while you work. End every answer with these four short sections, as
\`###\` headings in this order:
${EXPLAIN_SECTIONS.map((s) => `- **${s}**`).join('\n')}

"Why this approach" names the principle behind what you did; "Trade-offs considered" lists the options you weighed
and why you picked this one; "What a lead would watch for" names the risks and checks a senior engineer would keep in
mind; "Lesson" is one takeaway in plain words. If the lesson is worth keeping, also save it with \`add_lesson\`.`;

/** What is appended to a queued turn's prompt when another trigger for the same bot is merged into it. */
export function renderFollowUp(bot: PromptBot, messages: PromptMessage[]): string {
  return [
    '## Also new since this turn was queued',
    messages.map((m) => renderMessage(m, bot)).join('\n\n'),
  ].join('\n\n');
}

/** The text sent to the engine for one turn. */
export function buildPrompt(input: BuildPromptInput): string {
  const { bot, thread, newMessages, task, goal } = input;
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
  if (goal && thread.kind === 'goal') parts.push(renderGoal(goal));
  if (newMessages.length > 0) {
    const where =
      thread.kind === 'dm'
        ? 'this chat'
        : thread.kind === 'group'
          ? `#${thread.title}`
          : thread.kind === 'goal'
            ? 'this goal'
            : `the ${thread.kind} thread "${thread.title}"`;
    parts.push(
      `## New messages in ${where} since your last turn`,
      newMessages.map((m) => renderMessage(m, bot)).join('\n\n'),
    );
  }
  if (task) parts.push(renderTask(task, goal));
  if (input.review) parts.push(renderReview(input.review));
  if (input.report) parts.push(renderReport(input.report));
  if (explain) parts.push(EXPLAIN_MODE_TEXT);
  if (task) {
    parts.push(
      `Work on the task above and report what you did. When it meets the acceptance criteria, hand it in with \`submit_task_result\` (id ${task.id}, a summary and your artifacts' paths).`,
    );
  }
  if (thread.kind !== 'dm') {
    parts.push(
      `Reply as ${bot.name}. Others only see your final message in the thread; mention a teammate with @slug only when you need them.`,
    );
  }
  return parts.join('\n\n');
}

/** The lead's planning protocol for goal threads (F20), appended to its system prompt. */
export function planningProtocol(goal: Pick<Goal, 'autoRun' | 'maxTasks'>): string {
  return [
    '## Planning protocol (this thread is a goal from the owner)',
    '1. Restate the goal in one or two sentences.',
    '2. List your assumptions and any questions for the owner.',
    `3. Propose a plan: up to ${goal.maxTasks} tasks, each with a title, a short description, acceptance criteria and the best specialist for it (see \`list_bots\`). Mark work the owner must do themselves.`,
    goal.autoRun
      ? '4. Auto-run is on: create the tasks with `create_task` right away (assignee = the specialist); each one starts at once.'
      : '4. Ask the owner to confirm the plan, and wait. Once they confirm, create the tasks with `create_task` (assignee = the specialist); each one starts at once.',
    'Work only from non-confidential descriptions: never put secrets, credentials or confidential details in tasks.',
    'Specialists hand in with `submit_task_result`; you then review each result with `review_task`. When every task is done you write the goal report.',
  ].join('\n');
}

/** Short identity + platform rules appended to the engine's system prompt. */
export function buildSystemPromptAppend(
  bot: PromptBot,
  thread: PromptThread | null,
  goal?: Pick<Goal, 'autoRun' | 'maxTasks'> | null,
): string {
  return [
    `You are ${bot.name}${bot.role ? `, ${bot.role}` : ''}: one of the AI teammates on the owner's Agent A team (handle @${bot.slug}).`,
    thread ? `You are working in thread ${thread.id} (${thread.kind}).` : '',
    'Your computer is a Linux container: work in /home/bot/work, keep notes in /home/bot/notes, team files are in /shared.',
    'Use the `agenta` MCP tools to create tasks, message teammates, record decisions and request approval for risky external actions.',
    goal && thread?.kind === 'goal' ? planningProtocol(goal) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export type InstructionMemory = { title: string; contentMd: string; scope: 'bot' | 'shared' };

export type InstructionFiles = { 'CLAUDE.md': string; 'AGENTS.md': string };

/** A team skill as the instruction files show it (F21). */
export type InstructionSkill = { name: string; description: string; body: string };

/**
 * Renders /home/bot/CLAUDE.md and AGENTS.md from the bot's instructions and memory (already selected and capped,
 * MemoryService.forRender). Both engines get the same content, except skills: Claude Code loads them from
 * ~/.claude/skills itself, so CLAUDE.md only lists them; AGENTS.md carries their full text for Codex.
 */
export function renderInstructionFiles(
  bot: Pick<Bot, 'name' | 'role' | 'instructions' | 'isLead'>,
  memories: InstructionMemory[] = [],
  skills: InstructionSkill[] = [],
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
    '_Durable facts you saved (pinned first, then the newest). Save more with `save_memory` (never secrets); find older ones with `search_memory`._',
    mem(own),
    '## Team knowledge',
    mem(shared),
  ].filter(Boolean);
  const text = `${body.join('\n\n')}\n`;
  if (!skills.length) return { 'CLAUDE.md': text, 'AGENTS.md': text };
  const intro = 'Follow the matching skill when a task fits its description.';
  return {
    'CLAUDE.md': `${text}\n## Skills\n\nYour skills are in \`~/.claude/skills\`. ${intro}\n\n${skills
      .map((s) => `- \`${s.name}\`: ${s.description}`)
      .join('\n')}\n`,
    'AGENTS.md': `${text}\n## Skills\n\n${intro}\n\n${skills
      .map((s) => `### Skill: ${s.name}\n\n_${s.description}_\n\n${s.body.trim()}`)
      .join('\n\n')}\n`,
  };
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
