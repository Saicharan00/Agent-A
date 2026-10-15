'use client';

import { DECISION_STATUSES, type DecisionStatus, type DecisionView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, KanbanSquare, MessagesSquare, Plus, Scale } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Markdown } from '@/components/markdown';
import { ExportLink } from '@/components/export-link';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { useBots } from '@/hooks/use-bots';
import { relativeTime } from '@/lib/bots';
import { learnApi } from '@/lib/learn';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');
export const adrLabel = (n: number) => `ADR-${String(n).padStart(4, '0')}`;

const STATUS_TONE: Record<DecisionStatus, string> = {
  proposed: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  accepted: 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
  superseded: 'bg-muted text-muted-foreground line-through',
};

function StatusPill({ status }: { status: DecisionStatus }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_TONE[status])}>{status}</span>
  );
}

/** Decision records (ADRs): list with a status filter, the selected record, and "Record decision". */
export function DecisionsPanel() {
  const [status, setStatus] = useState<DecisionStatus | ''>('');
  const [selectedId, setSelectedId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: queryKeys.decisions(status || undefined),
    queryFn: () => learnApi.decisions(status || undefined),
  });
  const items = list.data ?? [];
  const selected = items.find((d) => d.id === selectedId) ?? items[0];

  return (
    <section aria-label="Decisions" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Filter by status"
          className="w-40"
          value={status}
          onChange={(e) => setStatus(e.target.value as DecisionStatus | '')}
        >
          <option value="">All statuses</option>
          {DECISION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        <ExportLink path="/export/decisions" />
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> Record decision
        </Button>
      </div>

      {list.isPending ? (
        <div className="h-24 animate-pulse rounded-lg border bg-muted/40" aria-busy="true" />
      ) : list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(list.error)}
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Scale}
          title={status ? `No ${status} decisions` : 'No decisions yet'}
          description="Why the team chose what it chose. Bots record them with record_decision; you can add them here. Each one is exported to /shared/decisions."
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <ul className="space-y-1" aria-label="Decision list">
            {items.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  aria-current={d.id === selected?.id}
                  onClick={() => setSelectedId(d.id)}
                  className={cn(
                    'w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent',
                    d.id === selected?.id && 'border-primary bg-primary/5',
                  )}
                >
                  <span className="block text-xs text-muted-foreground">
                    {adrLabel(d.number)} · {relativeTime(d.createdAt)}
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{d.title}</span>
                    <StatusPill status={d.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && <DecisionDetail decision={selected} />}
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Record decision"
        description="An architecture decision record: what was decided, why, and what follows from it."
      >
        {creating && (
          <DecisionForm
            onDone={(d) => {
              setCreating(false);
              setStatus('');
              setSelectedId(d.id);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}

function DecisionDetail({ decision: d }: { decision: DecisionView }) {
  const qc = useQueryClient();
  const bots = useBots('include');
  const author =
    d.createdBy === 'user' ? 'you' : (bots.data?.find((b) => b.id === d.createdBy)?.name ?? 'a bot');
  const setStatus = useMutation({
    mutationFn: (status: DecisionStatus) => learnApi.updateDecision(d.id, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.learn }),
    onError: (err) => toast.error(errorText(err)),
  });
  const sections: [string, string][] = [
    ['Context', d.contextMd],
    ['Options considered', d.optionsMd],
    ['Decision', d.decisionMd],
    ['Consequences', d.consequencesMd],
  ];

  return (
    <article aria-label={d.title} className="space-y-3 rounded-lg border bg-card p-4">
      <header className="space-y-1">
        <p className="text-xs text-muted-foreground">
          {adrLabel(d.number)} · recorded by {author} · {new Date(d.createdAt).toLocaleString()}
        </p>
        <h2 className="text-lg font-semibold">{d.title}</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Select
            aria-label="Decision status"
            className="h-8 w-36 text-xs"
            value={d.status}
            disabled={setStatus.isPending}
            onChange={(e) => setStatus.mutate(e.target.value as DecisionStatus)}
          >
            {DECISION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          {d.taskId && (
            <Link href="/tasks" className="inline-flex items-center gap-1 text-primary hover:underline">
              <KanbanSquare className="size-3.5" /> Task
            </Link>
          )}
          {d.threadId && (
            <Link
              href={`/threads/${d.threadId}`}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <MessagesSquare className="size-3.5" /> Thread
            </Link>
          )}
          <span
            className="inline-flex items-center gap-1 font-mono text-muted-foreground"
            title="Exported file"
          >
            <FileText className="size-3.5" />
            {d.path}
          </span>
        </div>
      </header>
      {sections.map(([title, body]) => (
        <section key={title} className="space-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          {body.trim() ? (
            <Markdown>{body}</Markdown>
          ) : (
            <p className="text-sm text-muted-foreground italic">None recorded.</p>
          )}
        </section>
      ))}
    </article>
  );
}

function DecisionForm({ onDone }: { onDone: (d: DecisionView) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [contextMd, setContext] = useState('');
  const [optionsMd, setOptions] = useState('');
  const [decisionMd, setDecision] = useState('');
  const [consequencesMd, setConsequences] = useState('');
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: () => learnApi.createDecision({ title, contextMd, optionsMd, decisionMd, consequencesMd }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: queryKeys.learn });
      toast.success(`${adrLabel(d.number)} recorded`);
      onDone(d);
    },
    onError: (err) => setError(errorText(err)),
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!title.trim()) return setError('Give it a title');
    setError(undefined);
    save.mutate();
  }

  const area = (id: string, label: string, value: string, set: (v: string) => void, hint?: string) => (
    <Field label={label} htmlFor={id} hint={hint}>
      <Textarea id={id} rows={3} value={value} onChange={(e) => set(e.target.value)} />
    </Field>
  );

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Decision">
      <Field label="Title" htmlFor="decision-title" error={error}>
        <Input id="decision-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      {area('decision-context', 'Context', contextMd, setContext, 'The situation and the forces at play.')}
      {area('decision-options', 'Options considered', optionsMd, setOptions)}
      {area('decision-decision', 'Decision', decisionMd, setDecision)}
      {area('decision-consequences', 'Consequences', consequencesMd, setConsequences)}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={save.isPending}>
          Record
        </Button>
      </div>
    </form>
  );
}
