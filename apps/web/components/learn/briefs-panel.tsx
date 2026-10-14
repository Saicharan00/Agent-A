'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, FileText, ShieldAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { useGoals } from '@/hooks/use-goals';
import { useTasks } from '@/hooks/use-tasks';
import { relativeTime } from '@/lib/bots';
import { learnApi } from '@/lib/learn';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/**
 * Carry-over briefs: ask Agent A for one from a task or goal (it saves it with save_handoff_brief), then read and copy
 * the briefs in /shared/handoff. A brief that fails the confidentiality check is never shown.
 */
export function BriefsPanel() {
  const router = useRouter();
  const [source, setSource] = useState('');
  const tasks = useTasks();
  const goals = useGoals();
  const list = useQuery({ queryKey: queryKeys.briefs, queryFn: learnApi.briefs });
  const ask = useMutation({
    mutationFn: () => {
      const [kind, id] = source.split(':') as ['task' | 'goal', string];
      return learnApi.carryOverBrief(kind === 'task' ? { taskId: id } : { goalId: id });
    },
    onSuccess: (r) => {
      toast.success('Agent A is writing the brief');
      router.push(`/threads/${r.threadId}`);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Brief copied');
    } catch {
      toast.error('Could not copy: the browser blocked the clipboard');
    }
  };
  const items = list.data ?? [];

  return (
    <section aria-label="Carry-over briefs" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Brief source"
          className="min-w-56 flex-1"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">Pick a task or goal…</option>
          <optgroup label="Goals">
            {(goals.data ?? []).map((g) => (
              <option key={g.id} value={`goal:${g.id}`}>
                {g.title}
              </option>
            ))}
          </optgroup>
          <optgroup label="Tasks">
            {(tasks.data ?? []).map((t) => (
              <option key={t.id} value={`task:${t.id}`}>
                {t.title}
              </option>
            ))}
          </optgroup>
        </Select>
        <Button size="sm" disabled={!source || ask.isPending} onClick={() => ask.mutate()}>
          <FileText /> Ask Agent A for a brief
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
          icon={FileText}
          title="No briefs yet"
          description="A carry-over brief is a short, sanitized how-to (what to do, steps, checks, risks) you can take elsewhere. Saved in /shared/handoff."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((b) => (
            <li key={b.name} className="rounded-lg border bg-card p-3" aria-label={b.title}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">{b.title}</h3>
                  <p className="font-mono text-xs text-muted-foreground">
                    {b.path} · {relativeTime(b.updatedAt)}
                  </p>
                </div>
                {b.guard.ok && (
                  <Button variant="outline" size="sm" onClick={() => void copy(b.contentMd)}>
                    <Copy /> Copy
                  </Button>
                )}
              </div>
              {b.guard.ok ? (
                <Markdown className="mt-2">{b.contentMd}</Markdown>
              ) : (
                <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
                  <ShieldAlert className="size-4" /> Withheld by the confidentiality check: {b.guard.reason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
