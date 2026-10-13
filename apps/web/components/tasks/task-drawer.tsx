'use client';

import {
  TASK_EXECUTORS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type BotView,
  type TaskDetail,
  type TaskPatchRequest,
} from '@agenta/shared';
import { Check, ExternalLink, FileText, MessagesSquare, Play, Undo2, X } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { Markdown } from '@/components/markdown';
import { useShell } from '@/components/shell/shell-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/form';
import { useTask, useTaskActions } from '@/hooks/use-tasks';
import { artifactKind, describeTaskEvent, dueInputToIso, isoToDueInput, statusLabel } from '@/lib/tasks';
import { PriorityBadge } from './task-board';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Prop({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/** Right-side drawer with a task's details, editable properties, review actions and timeline. */
export function TaskDrawer({
  taskId,
  onClose,
  onOpen,
  botsById,
}: {
  taskId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  botsById: Map<string, BotView>;
}) {
  const { data: task, error } = useTask(taskId);

  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskId, onClose]);

  if (!taskId) return null;
  return (
    <aside
      role="dialog"
      aria-label="Task details"
      data-testid="task-drawer"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(32rem,100vw)] flex-col border-l bg-background shadow-xl"
    >
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <h2 className="text-base font-semibold leading-snug">{task?.title ?? 'Task'}</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close task">
          <X />
        </Button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {task && <TaskBody task={task} botsById={botsById} onOpen={onOpen} />}
      </div>
    </aside>
  );
}

function TaskBody({
  task,
  botsById,
  onOpen,
}: {
  task: TaskDetail;
  botsById: Map<string, BotView>;
  onOpen: (id: string) => void;
}) {
  const { update, start, approve, requestChanges } = useTaskActions();
  const { openFile } = useShell();
  const [feedback, setFeedback] = useState('');
  const patch = (p: TaskPatchRequest) => update.mutate({ id: task.id, patch: p });
  const nameOf = (actor: string | null) =>
    actor === 'user' ? 'You' : ((actor && botsById.get(actor)?.name) ?? 'A former teammate');
  const assignee = task.assigneeBotId ? botsById.get(task.assigneeBotId) : undefined;
  const active = [...botsById.values()].filter((b) => !b.archivedAt || b.id === task.assigneeBotId);
  const canStart =
    !!assignee && !assignee.archivedAt && task.status !== 'done' && task.executedBy !== 'human';

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Prop label="Status" htmlFor="drawer-status">
          <Select
            id="drawer-status"
            className="h-8"
            value={task.status}
            onChange={(e) => patch({ status: e.target.value as TaskDetail['status'] })}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </Select>
        </Prop>
        <Prop label="Assignee" htmlFor="drawer-assignee">
          <Select
            id="drawer-assignee"
            className="h-8"
            value={task.assigneeBotId ?? ''}
            onChange={(e) => patch({ assigneeBotId: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {active.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Prop>
        <Prop label="Priority" htmlFor="drawer-priority">
          <Select
            id="drawer-priority"
            className="h-8"
            value={task.priority}
            onChange={(e) => patch({ priority: e.target.value as TaskDetail['priority'] })}
          >
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p.toUpperCase()}
              </option>
            ))}
          </Select>
        </Prop>
        <Prop label="Executed by" htmlFor="drawer-executor">
          <Select
            id="drawer-executor"
            className="h-8"
            value={task.executedBy}
            onChange={(e) => patch({ executedBy: e.target.value as TaskDetail['executedBy'] })}
          >
            {TASK_EXECUTORS.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </Prop>
        <Prop label="Due date" htmlFor="drawer-due">
          <Input
            id="drawer-due"
            type="date"
            className="h-8"
            value={isoToDueInput(task.dueAt)}
            onChange={(e) => patch({ dueAt: dueInputToIso(e.target.value) })}
          />
        </Prop>
        <div className="flex items-end gap-2">
          <PriorityBadge priority={task.priority} />
          {task.revisionCount > 0 && (
            <span className="text-xs text-muted-foreground">Revision {task.revisionCount}</span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {canStart && task.status !== 'in_review' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => start.mutate(task.id)}
            disabled={start.isPending}
          >
            <Play /> {task.taskThreadId ? 'Run again' : 'Start'}
          </Button>
        )}
        {task.taskThreadId && (
          <Link
            href={`/threads/${task.taskThreadId}`}
            className={buttonVariants({ size: 'sm', variant: 'outline' })}
          >
            <MessagesSquare /> Task thread
          </Link>
        )}
        {task.originThreadId && (
          <Link
            href={`/threads/${task.originThreadId}`}
            className={buttonVariants({ size: 'sm', variant: 'ghost' })}
          >
            <ExternalLink /> Origin thread
          </Link>
        )}
      </div>

      {task.status === 'in_review' && (
        <Section title="Review">
          <Textarea
            aria-label="Feedback"
            placeholder="What must change? (for Request changes)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            className="min-h-16"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => approve.mutate(task.id)} disabled={approve.isPending}>
              <Check /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!feedback.trim() || requestChanges.isPending}
              onClick={() =>
                requestChanges.mutate({ id: task.id, feedback }, { onSuccess: () => setFeedback('') })
              }
            >
              <Undo2 /> Request changes
            </Button>
          </div>
        </Section>
      )}

      <Section title="Description">
        {task.descriptionMd.trim() ? (
          <Markdown>{task.descriptionMd}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}
      </Section>
      {task.acceptanceMd.trim() && (
        <Section title="Acceptance criteria">
          <Markdown>{task.acceptanceMd}</Markdown>
        </Section>
      )}
      {task.resultSummaryMd && (
        <Section title="Result">
          <div data-testid="task-result">
            <Markdown>{task.resultSummaryMd}</Markdown>
          </div>
        </Section>
      )}
      {task.artifacts.length > 0 && (
        <Section title="Artifacts">
          <ul className="space-y-1 text-sm">
            {task.artifacts.map((a) => {
              const kind = artifactKind(a);
              return (
                <li key={a} className="font-mono text-xs">
                  {kind === 'url' ? (
                    <a href={a} target="_blank" rel="noreferrer" className="text-primary underline">
                      {a}
                    </a>
                  ) : kind === 'file' && assignee ? (
                    <button
                      type="button"
                      onClick={() => openFile(assignee.id, a)}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      <FileText className="size-3.5" /> {a}
                    </button>
                  ) : (
                    a
                  )}
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      {task.subtasks.length > 0 && (
        <Section title="Sub-tasks">
          <ul className="space-y-1">
            {task.subtasks.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpen(s.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                >
                  <span className="truncate">{s.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{statusLabel(s.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Timeline">
        <ol className="space-y-1.5 border-l pl-3 text-sm" data-testid="task-timeline">
          {task.events.map((e) => (
            <li key={e.id}>
              <span className="whitespace-pre-wrap break-words">{describeTaskEvent(e, nameOf)}</span>
              <time className="block text-xs text-muted-foreground" dateTime={e.createdAt}>
                {new Date(e.createdAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
