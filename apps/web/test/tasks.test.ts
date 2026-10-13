import type { TaskEventView, TaskView } from '@agenta/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { applyLiveEvent } from '@/lib/live-cache';
import { queryKeys } from '@/lib/query-keys';
import {
  NO_FILTERS,
  artifactKind,
  describeTaskEvent,
  dueInputToIso,
  filterTasks,
  groupByStatus,
  isoToDueInput,
} from '@/lib/tasks';

let n = 0;
function task(p: Partial<TaskView> = {}): TaskView {
  n++;
  return {
    id: `tsk_${n}`,
    title: `Task ${n}`,
    descriptionMd: '',
    acceptanceMd: '',
    status: 'todo',
    priority: 'p2',
    assigneeBotId: null,
    createdBy: 'user',
    parentTaskId: null,
    originThreadId: null,
    taskThreadId: null,
    executedBy: 'agent',
    revisionCount: 0,
    resultSummaryMd: null,
    artifacts: [],
    dueAt: null,
    goalId: null,
    createdAt: '2026-10-13T10:00:00.000Z',
    updatedAt: `2026-10-13T10:00:${String(n).padStart(2, '0')}.000Z`,
    ...p,
  };
}

describe('task board helpers', () => {
  const a = task({ assigneeBotId: 'bot_a', priority: 'p1' });
  const b = task({ parentTaskId: a.id, status: 'done' });
  const c = task({ priority: 'p0' });

  it('filters by assignee, unassigned, priority and parent', () => {
    expect(filterTasks([a, b, c], NO_FILTERS)).toHaveLength(3);
    expect(filterTasks([a, b, c], { ...NO_FILTERS, assignee: 'bot_a' })).toEqual([a]);
    expect(filterTasks([a, b, c], { ...NO_FILTERS, assignee: 'none' })).toEqual([b, c]);
    expect(filterTasks([a, b, c], { ...NO_FILTERS, priority: 'p0' })).toEqual([c]);
    expect(filterTasks([a, b, c], { ...NO_FILTERS, parent: 'top' })).toEqual([a, c]);
    expect(filterTasks([a, b, c], { ...NO_FILTERS, parent: a.id })).toEqual([b]);
  });

  it('groups into every status column, priority first', () => {
    const cols = groupByStatus([a, b, c]);
    expect(Object.keys(cols)).toEqual([
      'todo',
      'in_progress',
      'in_review',
      'changes_requested',
      'done',
      'blocked',
    ]);
    expect(cols.todo).toEqual([c, a]);
    expect(cols.done).toEqual([b]);
    expect(cols.blocked).toEqual([]);
  });

  it('round-trips due dates through the date input in local time', () => {
    expect(dueInputToIso('')).toBeNull();
    expect(isoToDueInput(dueInputToIso('2026-11-02'))).toBe('2026-11-02');
    expect(isoToDueInput(null)).toBe('');
  });

  it('classifies artifacts and words timeline events', () => {
    expect(artifactKind('/shared/out.md')).toBe('file');
    expect(artifactKind('https://example.com/x')).toBe('url');
    expect(artifactKind('see notes')).toBe('text');
    const ev = (kind: string, payload: Record<string, unknown>, actor = 'bot_a'): TaskEventView => ({
      id: 'tev_1',
      taskId: 't',
      kind,
      actor,
      payload,
      createdAt: '2026-10-13T10:00:00.000Z',
    });
    const nameOf = (x: string | null) => (x === 'user' ? 'You' : x === 'bot_a' ? 'Alice' : '?');
    expect(describeTaskEvent(ev('status', { from: 'todo', to: 'in_review' }, 'user'), nameOf)).toBe(
      'You moved it to In review',
    );
    expect(describeTaskEvent(ev('assigned', { to: 'bot_a' }, 'user'), nameOf)).toBe(
      'You assigned it to Alice',
    );
    expect(describeTaskEvent(ev('submitted', {}), nameOf)).toBe('Alice handed in the result');
    expect(describeTaskEvent(ev('reviewed', { verdict: 'request_changes', feedback: 'More' }), nameOf)).toBe(
      'Alice requested changes: More',
    );
  });

  it('task.changed invalidates every task query', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.taskList, [a]);
    qc.setQueryData(queryKeys.task(a.id), a);
    applyLiveEvent(qc, { type: 'task.changed', taskId: a.id });
    expect(qc.getQueryState(queryKeys.taskList)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.task(a.id))?.isInvalidated).toBe(true);
  });
});
