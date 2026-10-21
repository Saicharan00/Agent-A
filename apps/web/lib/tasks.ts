// Task board logic for the UI (F19): API calls, filters, board columns, due dates and timeline wording.
// Components only render what these return.
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskCreateRequest,
  type TaskEventView,
  type TaskPatchRequest,
  type TaskStatus,
  type TaskView,
  taskDetailSchema,
  taskViewSchema,
} from '@agenta/shared';
import { z } from 'zod';
import { apiRequest } from './api';

const enc = encodeURIComponent;

export const tasksApi = {
  list: () => apiRequest('/tasks', z.array(taskViewSchema)),
  get: (id: string) => apiRequest(`/tasks/${enc(id)}`, taskDetailSchema),
  create: (body: TaskCreateRequest) => apiRequest('/tasks', taskDetailSchema, { method: 'POST', body }),
  update: (id: string, body: TaskPatchRequest) =>
    apiRequest(`/tasks/${enc(id)}`, taskDetailSchema, { method: 'PATCH', body }),
  start: (id: string) => apiRequest(`/tasks/${enc(id)}/start`, taskDetailSchema, { method: 'POST' }),
  approve: (id: string) => apiRequest(`/tasks/${enc(id)}/approve`, taskDetailSchema, { method: 'POST' }),
  requestChanges: (id: string, feedback: string) =>
    apiRequest(`/tasks/${enc(id)}/request-changes`, taskDetailSchema, {
      method: 'POST',
      body: { feedback },
    }),
  remove: (id: string) => apiRequest(`/tasks/${enc(id)}`, z.unknown(), { method: 'DELETE' }),
};

/** '' = any. Assignee 'none' = unassigned; parent 'top' = top-level tasks only. */
export type TaskFilters = { assignee: string; priority: string; parent: string };
export const NO_FILTERS: TaskFilters = { assignee: '', priority: '', parent: '' };

export function filterTasks(tasks: TaskView[], f: TaskFilters): TaskView[] {
  return tasks.filter(
    (t) =>
      (!f.assignee || (f.assignee === 'none' ? !t.assigneeBotId : t.assigneeBotId === f.assignee)) &&
      (!f.priority || t.priority === f.priority) &&
      (!f.parent || (f.parent === 'top' ? !t.parentTaskId : t.parentTaskId === f.parent)),
  );
}

/** Board columns in status order; each sorted by priority (p0 first), then most recently updated. */
export function groupByStatus(tasks: TaskView[]): Record<TaskStatus, TaskView[]> {
  const cols = Object.fromEntries(TASK_STATUSES.map((s) => [s, [] as TaskView[]])) as Record<
    TaskStatus,
    TaskView[]
  >;
  const sorted = [...tasks].sort(
    (a, b) => a.priority.localeCompare(b.priority) || b.updatedAt.localeCompare(a.updatedAt),
  );
  for (const t of sorted) cols[t.status].push(t);
  return cols;
}

/** `<input type="date">` value (local day) → ISO at local midnight; '' → null. */
export function dueInputToIso(value: string): string | null {
  return value ? new Date(`${value}T00:00:00`).toISOString() : null;
}

/** ISO → `<input type="date">` value in local time. */
export function isoToDueInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** How an artifact entry opens: a path in the assignee's computer, a web link, or plain text. */
export function artifactKind(a: string): 'file' | 'url' | 'text' {
  if (/^https?:\/\//i.test(a)) return 'url';
  return a.startsWith('/') ? 'file' : 'text';
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One timeline line, e.g. "Alice handed in the result". `nameOf` resolves 'user' and bot ids. */
export function describeTaskEvent(e: TaskEventView, nameOf: (actor: string | null) => string): string {
  const who = nameOf(e.actor);
  const p = e.payload;
  switch (e.kind) {
    case 'created':
      return `${who} created the task`;
    case 'assigned':
      return p.to ? `${who} assigned it to ${nameOf(str(p.to))}` : `${who} unassigned it`;
    case 'status':
      return `${who} moved it to ${statusLabel(str(p.to))}`;
    case 'started':
      return `${who} started ${nameOf(str(p.assignee))}'s turn`;
    case 'note':
      return `${who}: ${str(p.note)}`;
    case 'submitted':
      return `${who} handed in the result`;
    case 'reviewed':
      return p.verdict === 'approve'
        ? `${who} approved it`
        : `${who} requested changes${p.feedback ? `: ${str(p.feedback)}` : ''}`;
    case 'executor':
      return `${who} set executed by to ${str(p.to)}`;
    case 'decision':
      return `${who} recorded a decision: ${str(p.title)}`;
    default:
      return `${who}: ${e.kind}`;
  }
}

export function statusLabel(s: string): string {
  return TASK_STATUS_LABELS[s as TaskStatus] ?? s;
}
