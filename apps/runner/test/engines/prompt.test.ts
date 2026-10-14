import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Message, loadTeamTemplate } from '@agenta/db';
import { describe, expect, it } from 'vitest';
import {
  type PromptMessage,
  type PromptTask,
  type PromptThread,
  buildPrompt,
  buildSystemPromptAppend,
  renderInstructionFiles,
  toPromptMessages,
  writeInstructionFiles,
} from '../../src/engines/prompt';

const bot = { id: 'bot_rev', name: 'Code Reviewer', slug: 'code-reviewer', role: 'Senior reviewer' };
const dm: PromptThread = { id: 'thr_dm', kind: 'dm', title: 'Code Reviewer', explainMode: false };
const group: PromptThread = { id: 'thr_grp', kind: 'group', title: 'Launch prep', explainMode: false };
const msg = (over: Partial<PromptMessage>): PromptMessage => ({
  authorType: 'user',
  authorName: 'Charan',
  contentMd: 'Can you review the login PR?',
  createdAt: '2026-10-12T14:03:27.123Z',
  mentions: [],
  ...over,
});
const task: PromptTask = {
  id: 'tsk_1',
  title: 'Review login PR #42',
  status: 'in_progress',
  priority: 'p1',
  descriptionMd: 'Check the new OAuth callback handler.',
  acceptanceMd: '- No secrets logged\n- Tests cover the error path',
  revisionCount: 1,
};

describe('buildPrompt', () => {
  it('plain DM turn = the message itself', () => {
    expect(buildPrompt({ bot, thread: dm, newMessages: [msg({ contentMd: '  hi there \n' })] })).toBe(
      'hi there',
    );
  });

  it('DM with several messages, task context and explain mode', () => {
    expect(
      buildPrompt({
        bot,
        thread: { ...dm, explainMode: true },
        newMessages: [
          msg({}),
          msg({ contentMd: 'Focus on error handling.', createdAt: '2026-10-12T14:04:00.000Z' }),
        ],
        task,
      }),
    ).toMatchSnapshot();
  });

  it('group thread: messages since last turn, bot authors, mentions', () => {
    expect(
      buildPrompt({
        bot,
        thread: group,
        newMessages: [
          msg({ contentMd: 'Status check, team?' }),
          msg({
            authorType: 'bot',
            authorName: 'Builder',
            contentMd: 'Login PR is ready. @code-reviewer please look.',
            mentions: ['bot_rev'],
          }),
          msg({ authorType: 'system', authorName: 'System', contentMd: 'Builder finished run run_9.' }),
        ],
        group: {
          purpose: 'Get v1 out the door.',
          members: [
            { id: 'bot_lead', name: 'Agent A', slug: 'agent-a', role: 'Lead AI Engineer', isLead: true },
            { id: bot.id, name: bot.name, slug: bot.slug, role: bot.role, isLead: false },
          ],
          moderatorId: bot.id,
        },
      }),
    ).toMatchSnapshot();
  });

  it('task thread without new messages renders the task alone', () => {
    expect(
      buildPrompt({ bot, thread: { ...dm, kind: 'task', title: 'Review' }, newMessages: [], task }),
    ).toMatchSnapshot();
  });

  it('explainMode argument overrides the thread flag', () => {
    const p = buildPrompt({ bot, thread: dm, newMessages: [msg({})], explainMode: true });
    expect(p).toContain('## Explain mode is on');
    for (const s of ['Why this approach', 'Trade-offs considered', 'What a lead would watch for', 'Lesson'])
      expect(p).toContain(`- **${s}**`);
  });
});

describe('toPromptMessages', () => {
  it('resolves author names', () => {
    const base = { threadId: 't', runId: null, mentions: [], createdAt: '2026-10-12T00:00:00.000Z' };
    const rows = [
      { ...base, id: 'm1', authorType: 'user', authorBotId: null, contentMd: 'a' },
      { ...base, id: 'm2', authorType: 'bot', authorBotId: 'bot_b', contentMd: 'b' },
      { ...base, id: 'm3', authorType: 'bot', authorBotId: 'bot_gone', contentMd: 'c' },
      { ...base, id: 'm4', authorType: 'system', authorBotId: null, contentMd: 'd' },
    ] as Message[];
    expect(
      toPromptMessages(rows, new Map([['bot_b', { name: 'Builder' }]]), 'Charan').map((m) => m.authorName),
    ).toEqual(['Charan', 'Builder', 'A former teammate', 'System']);
  });
});

describe('system prompt + instruction files', () => {
  it('system prompt append', () => {
    expect(buildSystemPromptAppend(bot, group)).toMatchSnapshot();
  });

  it('CLAUDE.md / AGENTS.md without memory and with memory (F22)', () => {
    const lead = {
      name: 'Agent A',
      role: 'Lead AI Engineer',
      instructions: 'Plan, delegate, review, teach.',
      isLead: true,
    };
    const empty = renderInstructionFiles({ ...lead, instructions: '  ' });
    expect(empty['CLAUDE.md']).toBe(empty['AGENTS.md']);
    expect(empty['CLAUDE.md']).toMatchSnapshot();
    expect(
      renderInstructionFiles(lead, [
        { scope: 'bot', title: 'Owner prefers pnpm', contentMd: 'Use pnpm, never npm.' },
        { scope: 'shared', title: 'Repo layout', contentMd: 'apps/ and packages/.' },
      ])['CLAUDE.md'],
    ).toMatchSnapshot();
  });

  it('writes both files into the home, replacing placeholders', () => {
    const home = mkdtempSync(join(tmpdir(), 'agenta-prompt-'));
    try {
      const files = renderInstructionFiles({ name: 'X', role: '', instructions: 'Be brief.', isLead: false });
      writeInstructionFiles(home, files);
      writeInstructionFiles(home, files);
      expect(readFileSync(join(home, 'CLAUDE.md'), 'utf8')).toContain('Be brief.');
      expect(readFileSync(join(home, 'AGENTS.md'), 'utf8')).toBe(files['AGENTS.md']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('team template instruction files (F21)', () => {
  const template = loadTeamTemplate(join(import.meta.dirname, '../../../../templates/team'));
  for (const t of template.bots) {
    it(`renders ${t.slug}`, () => {
      const skills = t.skills.map((n) => template.skills.get(n)!);
      const files = renderInstructionFiles({ ...t, isLead: t.isLead }, [], skills);
      expect(files['CLAUDE.md']).toMatchSnapshot('CLAUDE.md');
      expect(files['AGENTS.md']).toMatchSnapshot('AGENTS.md');
      for (const s of skills) {
        expect(files['CLAUDE.md']).toContain(`- \`${s.name}\`: ${s.description}`);
        expect(files['AGENTS.md']).toContain(s.body);
      }
    });
  }
});

describe('goal prompts (F20)', () => {
  const lead = { id: 'bot_lead', name: 'Agent A', slug: 'agent-a', role: 'Lead AI Engineer' };
  const goalThread: PromptThread = { id: 'thr_goal', kind: 'goal', title: 'Launch page', explainMode: false };
  const taskThread: PromptThread = { id: 'thr_task', kind: 'task', title: 'Build it', explainMode: false };
  const goal = {
    id: 'gol_1',
    title: 'Launch page',
    slug: 'launch-page-abc123',
    goalMd: 'Ship a launch page for the side project.',
    constraintsMd: 'No customer data.',
    autoRun: false,
    confirmedAt: null as string | null,
    maxTasks: 12,
    tasksTotal: 0,
    tasksDone: 0,
  };

  it('the lead plans, creates tasks once confirmed, then sees progress', () => {
    const turn = (g: typeof goal) =>
      buildPrompt({
        bot: lead,
        thread: goalThread,
        newMessages: [msg({ contentMd: 'Here is my goal' })],
        goal: g,
      });
    expect(turn(goal)).toMatchSnapshot();
    expect(turn({ ...goal, confirmedAt: '2026-10-13T10:00:00.000Z' })).toContain('Create the tasks now');
    expect(turn({ ...goal, autoRun: true })).toContain('auto-run is on');
    expect(turn({ ...goal, tasksTotal: 3, tasksDone: 1 })).toContain('Progress: 1/3 tasks done.');
  });

  it('planning protocol only in goal threads', () => {
    expect(buildSystemPromptAppend(lead, goalThread, goal)).toMatchSnapshot();
    expect(buildSystemPromptAppend(lead, taskThread, goal)).not.toContain('Planning protocol');
  });

  it('task brief with goal context, review and report turns', () => {
    expect(buildPrompt({ bot, thread: taskThread, newMessages: [], task, goal })).toMatchSnapshot();
    expect(
      buildPrompt({
        bot: lead,
        thread: goalThread,
        newMessages: [],
        goal: { ...goal, tasksTotal: 2 },
        review: {
          ...task,
          assigneeName: 'Code Reviewer',
          resultSummaryMd: 'Reviewed, two comments.',
          artifacts: ['/shared/projects/launch-page-abc123/review.md'],
        },
      }),
    ).toMatchSnapshot();
    expect(
      buildPrompt({
        bot: lead,
        thread: goalThread,
        newMessages: [],
        goal: { ...goal, tasksTotal: 1, tasksDone: 1 },
        report: [
          {
            id: 'tsk_1',
            title: 'Review login PR #42',
            resultSummaryMd: 'Done.',
            artifacts: [],
            executedBy: 'agent',
            assigneeName: 'Code Reviewer',
          },
        ],
      }),
    ).toMatchSnapshot();
  });
});
