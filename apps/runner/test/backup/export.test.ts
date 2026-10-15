import type { Decision, Goal, Lesson, Message, Task, Thread } from '@agenta/db';
import { describe, expect, it } from 'vitest';
import { renderDecisions, renderGoalReport, renderLessons, renderThread } from '../../src/backup/export';

// Markdown export snapshots (F32). Rows carry only the fields the renderers read.
const at = '2026-10-15T09:30:12.345Z';
const names = new Map([
  ['bot_lead', 'Agent A'],
  ['bot_dev', 'Builder'],
]);

const thread = {
  id: 'thr_1',
  kind: 'group',
  title: 'Launch plan',
  createdAt: '2026-10-14T08:00:00.000Z',
} as Thread;
const msg = (
  authorType: Message['authorType'],
  authorBotId: string | null,
  contentMd: string,
  createdAt: string,
) =>
  ({ id: `msg_${createdAt}`, threadId: 'thr_1', authorType, authorBotId, contentMd, createdAt }) as Message;

const goal = {
  id: 'goal_1',
  title: 'Ship the landing page',
  slug: 'ship-the-landing-page',
  goalMd: 'A one-page site with a sign-up form.',
  constraintsMd: 'No paid services.',
  status: 'done',
  createdAt: '2026-10-14T08:00:00.000Z',
  finishedAt: '2026-10-15T08:00:00.000Z',
} as Goal;
const task = (
  title: string,
  status: Task['status'],
  assigneeBotId: string | null,
  resultSummaryMd: string | null,
) => ({ title, status, assigneeBotId, resultSummaryMd }) as Task;

const decision = (number: number, title: string) =>
  ({
    number,
    title,
    status: 'accepted',
    contextMd: 'We need a database.',
    optionsMd: '- SQLite\n- Postgres',
    decisionMd: 'SQLite.',
    consequencesMd: '',
    taskId: null,
    threadId: 'thr_1',
    createdAt: '2026-10-14T10:00:00.000Z',
  }) as Decision;

const lesson = (topic: string, lessonMd: string, whyItMattersMd: string) =>
  ({
    topic,
    lessonMd,
    whyItMattersMd,
    source: 'task',
    reviewedCount: 2,
    createdAt: '2026-10-13T10:00:00.000Z',
  }) as Lesson;

describe('Markdown exports', () => {
  it('thread', () => {
    const md = renderThread(
      thread,
      [
        msg('user', null, '@Builder draft the page', '2026-10-14T08:01:00.000Z'),
        msg('bot', 'bot_dev', 'Done: `index.html`\n\n```html\n<h1>Hi</h1>\n```', '2026-10-14T08:05:00.000Z'),
        msg('system', null, 'Builder joined.', '2026-10-14T08:06:00.000Z'),
        msg('bot', 'bot_gone', 'old reply', '2026-10-14T08:07:00.000Z'),
      ],
      names,
      at,
    );
    expect(md).toMatchSnapshot();
    expect(renderThread(thread, [], names, at)).toContain('_No messages._');
  });

  it('goal report', () => {
    const md = renderGoalReport(
      goal,
      [
        task('Write copy', 'done', 'bot_dev', 'Copy in `copy.md`.\nTwo variants.'),
        task('Pick colours', 'in_progress', null, null),
      ],
      '## Summary\n\nShipped.\n\n```sh\n# not a heading\n```',
      names,
      at,
    );
    expect(md).toMatchSnapshot();
    expect(
      renderGoalReport({ ...goal, constraintsMd: '', finishedAt: null }, [], undefined, names, at),
    ).toContain('_No report yet._');
  });

  it('decisions and lessons', () => {
    expect(renderDecisions([decision(2, 'Use croner'), decision(1, 'Use SQLite')], at)).toMatchSnapshot();
    expect(
      renderLessons(
        [
          lesson('Testing', 'Mock the engine.', 'Real runs burn limits.'),
          lesson('Git', 'Small commits.', ''),
        ],
        at,
      ),
    ).toMatchSnapshot();
  });
});
