'use client';

import {
  TASK_EXECUTORS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type BotView,
  type TaskExecutor,
  type TaskPriority,
  type TaskStatus,
  type TaskView,
} from '@agenta/shared';
import { Columns3, KanbanSquare, List, Plus } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { EmptyState } from '@/components/empty-state';
import { Page, PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { useBots } from '@/hooks/use-bots';
import { useTaskActions, useTasks } from '@/hooks/use-tasks';
import {
  NO_FILTERS,
  type TaskFilters,
  dueInputToIso,
  filterTasks,
  groupByStatus,
  statusLabel,
} from '@/lib/tasks';
import { cn } from '@/lib/utils';
import { TaskDrawer } from './task-drawer';

const PRIORITY_TONE: Record<TaskPriority, string> = {
  p0: 'bg-red-500/15 text-red-700 dark:text-red-400',
  p1: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  p2: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  p3: 'bg-muted text-muted-foreground',
};

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] uppercase', PRIORITY_TONE[priority])}>
      {priority}
    </span>
  );
}

function Assignee({ bot }: { bot: BotView | undefined }) {
  if (!bot) return <span className="text-xs text-muted-foreground">Unassigned</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <BotAvatar name={bot.name} color={bot.avatarColor} shape={bot.avatarShape} size="sm" />
      <span className="truncate">{bot.name}</span>
    </span>
  );
}

/** The `/tasks` page: filters, Kanban (drag a card to change its status) or list view, and the detail drawer. */
export function TaskBoard() {
  const tasks = useTasks();
  const { data: bots } = useBots('include');
  const { update } = useTaskActions();
  const [filters, setFilters] = useState<TaskFilters>(NO_FILTERS);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  const botsById = useMemo(() => new Map((bots ?? []).map((b) => [b.id, b])), [bots]);
  const all = tasks.data ?? [];
  const shown = useMemo(() => filterTasks(all, filters), [all, filters]);
  const columns = useMemo(() => groupByStatus(shown), [shown]);
  const parents = useMemo(() => {
    const ids = new Set(all.map((t) => t.parentTaskId).filter(Boolean));
    return all.filter((t) => ids.has(t.id));
  }, [all]);

  function drop(status: TaskStatus, taskId: string) {
    setDragOver(null);
    const task = all.find((t) => t.id === taskId);
    if (task && task.status !== status) update.mutate({ id: taskId, patch: { status } });
  }

  const setFilter = (k: keyof TaskFilters) => (e: { target: { value: string } }) =>
    setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Page className="max-w-none">
      <PageHeader
        title="Tasks"
        description="Work your team is doing, from to do to done. Assign a task to a bot to start it."
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New task
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <Select
          aria-label="Assignee"
          className="h-8 w-44"
          value={filters.assignee}
          onChange={setFilter('assignee')}
        >
          <option value="">Any assignee</option>
          <option value="none">Unassigned</option>
          {(bots ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Priority"
          className="h-8 w-32"
          value={filters.priority}
          onChange={setFilter('priority')}
        >
          <option value="">Any priority</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p.toUpperCase()}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Parent"
          className="h-8 w-48"
          value={filters.parent}
          onChange={setFilter('parent')}
        >
          <option value="">Any parent</option>
          <option value="top">Top-level only</option>
          {parents.map((t) => (
            <option key={t.id} value={t.id}>
              Sub-tasks of {t.title}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex rounded-md border p-0.5" role="group" aria-label="View">
          <Button
            size="sm"
            variant={view === 'board' ? 'secondary' : 'ghost'}
            aria-pressed={view === 'board'}
            onClick={() => setView('board')}
          >
            <Columns3 /> Board
          </Button>
          <Button
            size="sm"
            variant={view === 'list' ? 'secondary' : 'ghost'}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            <List /> List
          </Button>
        </div>
      </div>

      {tasks.error ? (
        <EmptyState icon={KanbanSquare} title="Could not load tasks" description={tasks.error.message} />
      ) : tasks.data && all.length === 0 ? (
        <EmptyState
          icon={KanbanSquare}
          title="No tasks yet"
          description="Create one here, or ask Agent A to plan a goal."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus /> New task
            </Button>
          }
        />
      ) : view === 'board' ? (
        <div
          className="grid auto-cols-[minmax(12rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
          // Scrolls sideways when columns overflow; focusable so keyboard users can scroll it (WCAG).
          tabIndex={0}
          role="region"
          aria-label="Task columns"
        >
          {TASK_STATUSES.map((status) => (
            <section
              key={status}
              aria-label={statusLabel(status)}
              data-testid="task-column"
              data-status={status}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(status);
              }}
              onDragLeave={() => setDragOver((s) => (s === status ? null : s))}
              onDrop={(e) => {
                e.preventDefault();
                drop(status, e.dataTransfer.getData('text/plain'));
              }}
              className={cn(
                'flex min-h-64 flex-col gap-2 rounded-lg border bg-muted/30 p-2 transition-colors',
                dragOver === status && 'border-primary bg-primary/5',
              )}
            >
              <h2 className="flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                {statusLabel(status)}
                <span className="tabular-nums">{columns[status].length}</span>
              </h2>
              {columns[status].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  draggable
                  data-testid="task-card"
                  data-task-id={t.id}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/plain', t.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => setOpenId(t.id)}
                  className="space-y-2 rounded-md border bg-card p-2.5 text-left shadow-xs hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="block text-sm font-medium leading-snug">{t.title}</span>
                  <span className="flex items-center justify-between gap-2">
                    <Assignee bot={t.assigneeBotId ? botsById.get(t.assigneeBotId) : undefined} />
                    <PriorityBadge priority={t.priority} />
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <table className="w-full text-sm" data-testid="task-list">
          <thead className="text-left text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">Title</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Priority</th>
              <th className="py-2 font-medium">Assignee</th>
              <th className="py-2 font-medium">Due</th>
            </tr>
          </thead>
          <tbody>
            {TASK_STATUSES.flatMap((s) => columns[s]).map((t) => (
              <tr
                key={t.id}
                className="cursor-pointer border-b hover:bg-accent/50"
                onClick={() => setOpenId(t.id)}
              >
                <td className="py-2">
                  <button type="button" className="text-left font-medium hover:underline">
                    {t.title}
                  </button>
                </td>
                <td className="py-2">{statusLabel(t.status)}</td>
                <td className="py-2">
                  <PriorityBadge priority={t.priority} />
                </td>
                <td className="py-2">
                  <Assignee bot={t.assigneeBotId ? botsById.get(t.assigneeBotId) : undefined} />
                </td>
                <td className="py-2 text-muted-foreground">
                  {t.dueAt ? new Date(t.dueAt).toLocaleDateString() : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <NewTaskDialog open={creating} onClose={() => setCreating(false)} bots={bots ?? []} tasks={all} />
      <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} botsById={botsById} />
    </Page>
  );
}

function NewTaskDialog({
  open,
  onClose,
  bots,
  tasks,
}: {
  open: boolean;
  onClose: () => void;
  bots: BotView[];
  tasks: TaskView[];
}) {
  const { create } = useTaskActions();
  const empty = {
    title: '',
    descriptionMd: '',
    acceptanceMd: '',
    priority: 'p2' as TaskPriority,
    assigneeBotId: '',
    parentTaskId: '',
    executedBy: 'agent' as TaskExecutor,
    due: '',
  };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function close() {
    setForm(empty);
    setError(null);
    onClose();
  }

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!form.title.trim()) return setError('Give the task a title');
    create.mutate(
      {
        title: form.title,
        descriptionMd: form.descriptionMd,
        acceptanceMd: form.acceptanceMd,
        priority: form.priority,
        assigneeBotId: form.assigneeBotId || null,
        parentTaskId: form.parentTaskId || null,
        executedBy: form.executedBy,
        dueAt: dueInputToIso(form.due),
      },
      {
        onSuccess: close,
        onError: (err) => setError(err instanceof Error ? err.message : 'Could not create the task'),
      },
    );
  }

  const active = bots.filter((b) => !b.archivedAt);
  return (
    <Dialog
      open={open}
      onClose={close}
      title="New task"
      description="Assigned to a bot, the task starts right away in its own task thread."
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Title" htmlFor="task-title" error={error ?? undefined}>
          <Input id="task-title" value={form.title} onChange={set('title')} autoFocus />
        </Field>
        <Field label="Description" htmlFor="task-description">
          <Textarea
            id="task-description"
            value={form.descriptionMd}
            onChange={set('descriptionMd')}
            className="min-h-20"
          />
        </Field>
        <Field label="Acceptance criteria" htmlFor="task-acceptance">
          <Textarea
            id="task-acceptance"
            value={form.acceptanceMd}
            onChange={set('acceptanceMd')}
            className="min-h-16"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assignee" htmlFor="task-assignee">
            <Select id="task-assignee" value={form.assigneeBotId} onChange={set('assigneeBotId')}>
              <option value="">Unassigned</option>
              {active.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority" htmlFor="task-priority">
            <Select id="task-priority" value={form.priority} onChange={set('priority')}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Executed by" htmlFor="task-executor">
            <Select id="task-executor" value={form.executedBy} onChange={set('executedBy')}>
              {TASK_EXECUTORS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Due date" htmlFor="task-due">
            <Input id="task-due" type="date" value={form.due} onChange={set('due')} />
          </Field>
        </div>
        <Field label="Parent task" htmlFor="task-parent">
          <Select id="task-parent" value={form.parentTaskId} onChange={set('parentTaskId')}>
            <option value="">None</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            Create task
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
