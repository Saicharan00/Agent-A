// Goals for the UI (F20): API calls and the wording/progress the home page and goal threads show.
import { type GoalCreateRequest, type GoalView, goalViewSchema } from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

const enc = encodeURIComponent;

export const goalsApi = {
  list: () => apiRequest('/goals', z.array(goalViewSchema)),
  get: (id: string) => apiRequest(`/goals/${enc(id)}`, goalViewSchema),
  create: (body: GoalCreateRequest) => apiRequest('/goals', goalViewSchema, { method: 'POST', body }),
  confirm: (id: string) => apiRequest(`/goals/${enc(id)}/confirm`, goalViewSchema, { method: 'POST' }),
  pause: (id: string) => apiRequest(`/goals/${enc(id)}/pause`, goalViewSchema, { method: 'POST' }),
  resume: (id: string) => apiRequest(`/goals/${enc(id)}/resume`, goalViewSchema, { method: 'POST' }),
  remove: (id: string) => apiRequest(`/goals/${enc(id)}`, z.unknown(), { method: 'DELETE' }),
};

/** Done tasks as a whole percentage (0 while there are no tasks; 100 once the goal is done). */
export function goalPercent(g: Pick<GoalView, 'status' | 'tasksDone' | 'tasksTotal'>): number {
  if (g.status === 'done') return 100;
  return g.tasksTotal ? Math.round((g.tasksDone / g.tasksTotal) * 100) : 0;
}

/** Where the goal stands, in a few words. */
export function goalStatusText(g: GoalView): string {
  if (g.pausedAt) return 'Paused';
  switch (g.status) {
    case 'planning':
      return g.confirmedAt || g.autoRun ? 'Creating tasks' : 'Waiting for you to confirm the plan';
    case 'in_progress':
      return 'In progress';
    case 'reporting':
      return 'Writing the report';
    case 'done':
      return 'Done';
  }
}

/** The owner can confirm a plan Agent A is waiting on. */
export function canConfirm(g: GoalView): boolean {
  return g.status === 'planning' && !g.confirmedAt && !g.autoRun && !g.pausedAt;
}
