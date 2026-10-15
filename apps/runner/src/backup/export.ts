import type { Decision, Goal, Lesson, Message, Repos, Task, Thread } from '@agenta/db';
import { slugify } from '@agenta/db';
import { renderDecision } from '../learn/service';

// Markdown exports (F32): a thread, a goal report, all decisions, all lessons. Pure renderers + a loader per export.

export type MarkdownExport = { filename: string; markdown: string };

/** 2026-10-15T09:30:12.345Z → 2026-10-15 09:30 UTC (files carry UTC; the UI shows local time). */
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const file = (prefix: string, title: string) => `${prefix}-${slugify(title) || 'untitled'}.md`;

/** Pushes every Markdown heading `by` levels down (max 6), so embedded documents nest; code fences are left alone. */
export function demoteHeadings(md: string, by: number): string {
  let fence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) return line;
      return line.replace(/^(#{1,6}) /, (_m, h: string) => `${'#'.repeat(Math.min(6, h.length + by))} `);
    })
    .join('\n');
}

export function renderThread(
  thread: Thread,
  messages: Message[],
  botNames: Map<string, string>,
  exportedAt: string,
): string {
  const author = (m: Message) =>
    m.authorType === 'user'
      ? 'You'
      : m.authorType === 'system'
        ? 'System'
        : (botNames.get(m.authorBotId ?? '') ?? 'Deleted bot');
  const body = messages.map((m) => `**${author(m)}** · ${when(m.createdAt)}\n\n${m.contentMd.trim()}\n`);
  return [
    `# ${thread.title}\n`,
    `- Kind: ${thread.kind}`,
    `- Started: ${when(thread.createdAt)}`,
    `- Messages: ${messages.length}`,
    `- Exported: ${when(exportedAt)}\n`,
    ...(body.length ? body.flatMap((b) => ['---\n', b]) : ['_No messages._\n']),
  ].join('\n');
}

export function renderGoalReport(
  goal: Goal,
  tasks: Task[],
  report: string | undefined,
  botNames: Map<string, string>,
  exportedAt: string,
): string {
  const taskLines = tasks.map((t) => {
    const who = botNames.get(t.assigneeBotId ?? '') ?? 'unassigned';
    const summary = t.resultSummaryMd?.trim();
    return `- [${t.status === 'done' ? 'x' : ' '}] ${t.title} (${t.status}, ${who})${summary ? `\n\n  ${summary.replaceAll('\n', '\n  ')}\n` : ''}`;
  });
  return [
    `# Goal: ${goal.title}\n`,
    `- Status: ${goal.status}`,
    `- Started: ${when(goal.createdAt)}`,
    ...(goal.finishedAt ? [`- Finished: ${when(goal.finishedAt)}`] : []),
    `- Artifacts: /shared/projects/${goal.slug}/`,
    `- Exported: ${when(exportedAt)}\n`,
    `## Goal\n\n${goal.goalMd.trim()}\n`,
    ...(goal.constraintsMd.trim() ? [`## Constraints\n\n${goal.constraintsMd.trim()}\n`] : []),
    `## Tasks\n\n${taskLines.join('\n') || '_No tasks._'}\n`,
    `## Report\n\n${demoteHeadings(report?.trim() || '_No report yet._', 2)}\n`,
  ].join('\n');
}

export function renderDecisions(decisions: Decision[], exportedAt: string): string {
  const sorted = [...decisions].sort((a, b) => a.number - b.number);
  return [
    `# Decisions\n`,
    `- Count: ${sorted.length}`,
    `- Exported: ${when(exportedAt)}\n`,
    ...(sorted.length
      ? sorted.flatMap((d) => ['---\n', demoteHeadings(renderDecision(d), 1)])
      : ['_None._\n']),
  ].join('\n');
}

export function renderLessons(lessons: Lesson[], exportedAt: string): string {
  const sorted = [...lessons].sort(
    (a, b) => a.topic.localeCompare(b.topic) || a.createdAt.localeCompare(b.createdAt),
  );
  const one = (l: Lesson) =>
    [
      `## ${l.topic}\n`,
      `${l.lessonMd.trim()}\n`,
      ...(l.whyItMattersMd.trim() ? [`**Why it matters:** ${l.whyItMattersMd.trim()}\n`] : []),
      `_Source: ${l.source} · added ${l.createdAt.slice(0, 10)} · reviewed ${l.reviewedCount}×_\n`,
    ].join('\n');
  return [
    `# Lessons\n`,
    `- Count: ${sorted.length}`,
    `- Exported: ${when(exportedAt)}\n`,
    ...(sorted.length ? sorted.map(one) : ['_None._\n']),
  ].join('\n');
}

// ---------- loaders (undefined = not found) ----------

const names = (repos: Repos) =>
  new Map(repos.bots.list({ includeArchived: true }).map((b) => [b.id, b.name]));

export function exportThread(repos: Repos, threadId: string, now: string): MarkdownExport | undefined {
  const thread = repos.threads.get(threadId);
  if (!thread) return undefined;
  const messages: Message[] = [];
  for (;;) {
    const page = repos.messages.listSince(threadId, messages.at(-1)?.id ?? null, 500);
    messages.push(...page);
    if (page.length < 500) break;
  }
  return {
    filename: file('thread', thread.title),
    markdown: renderThread(thread, messages, names(repos), now),
  };
}

export function exportGoal(repos: Repos, goalId: string, now: string): MarkdownExport | undefined {
  const goal = repos.goals.get(goalId);
  if (!goal) return undefined;
  const report = goal.reportRunId ? repos.messages.getByRun(goal.reportRunId)?.contentMd : undefined;
  return {
    filename: file('goal', goal.title),
    markdown: renderGoalReport(goal, repos.goals.listTasks(goalId), report, names(repos), now),
  };
}

export const exportDecisions = (repos: Repos, now: string): MarkdownExport => ({
  filename: 'decisions.md',
  markdown: renderDecisions(repos.decisions.list(), now),
});

export const exportLessons = (repos: Repos, now: string): MarkdownExport => ({
  filename: 'lessons.md',
  markdown: renderLessons(repos.lessons.list(), now),
});
