import type { GoalView } from '@agenta/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { canConfirm, goalPercent, goalStatusText } from '@/lib/goals';
import { applyLiveEvent } from '@/lib/live-cache';
import { queryKeys } from '@/lib/query-keys';

const goal = (over: Partial<GoalView> = {}): GoalView => ({
  id: 'gol_1',
  title: 'Launch page',
  slug: 'launch-page-abc',
  goalMd: 'Ship it',
  constraintsMd: '',
  status: 'planning',
  autoRun: false,
  confirmedAt: null,
  pausedAt: null,
  maxTasks: 12,
  maxRuns: 40,
  leadBotId: 'bot_lead',
  threadId: 'thr_1',
  reportRunId: null,
  finishedAt: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
  tasksTotal: 0,
  tasksDone: 0,
  runsUsed: 1,
  ...over,
});

describe('goals', () => {
  it('progress percentage', () => {
    expect(goalPercent(goal())).toBe(0);
    expect(goalPercent(goal({ status: 'in_progress', tasksTotal: 3, tasksDone: 1 }))).toBe(33);
    expect(goalPercent(goal({ status: 'done', tasksTotal: 0 }))).toBe(100);
  });

  it('status wording and when the owner can confirm', () => {
    expect(goalStatusText(goal())).toBe('Waiting for you to confirm the plan');
    expect(canConfirm(goal())).toBe(true);
    expect(goalStatusText(goal({ autoRun: true }))).toBe('Creating tasks');
    expect(canConfirm(goal({ autoRun: true }))).toBe(false);
    expect(goalStatusText(goal({ pausedAt: '2026-10-13T11:00:00.000Z' }))).toBe('Paused');
    expect(canConfirm(goal({ pausedAt: '2026-10-13T11:00:00.000Z' }))).toBe(false);
    expect(goalStatusText(goal({ status: 'reporting' }))).toBe('Writing the report');
  });

  it('goal, task and run events refresh the goal list', () => {
    const qc = new QueryClient();
    const stale = () => qc.getQueryState(queryKeys.goalList)?.isInvalidated;
    for (const event of [
      { type: 'goal.changed', goalId: 'gol_1' },
      { type: 'task.changed', taskId: 'tsk_1' },
      {
        type: 'run.updated',
        runId: 'run_1',
        botId: 'bot_1',
        threadId: null,
        taskId: null,
        status: 'queued',
        error: null,
      },
    ] as const) {
      qc.setQueryData(queryKeys.goalList, [goal()]);
      expect(stale()).toBe(false);
      applyLiveEvent(qc, event);
      expect(stale()).toBe(true);
    }
  });
});
