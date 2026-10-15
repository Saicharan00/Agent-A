'use client';

import type { LessonReviewResult, LessonView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lightbulb, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { Markdown } from '@/components/markdown';
import { ExportLink } from '@/components/export-link';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/form';
import { relativeTime } from '@/lib/bots';
import { isDue, learnApi } from '@/lib/learn';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

const SOURCE_LABEL: Record<LessonView['source'], string> = {
  manual: 'Added by hand',
  run: 'From a bot run',
  task: 'From a task',
  decision: 'From a decision',
};

/** "in 3 days" / "due now" for the next review. */
function reviewLabel(l: LessonView): string {
  if (!l.nextReviewAt) return 'No review scheduled';
  if (isDue(l.nextReviewAt)) return 'Review due now';
  return `Next review ${new Date(l.nextReviewAt).toLocaleDateString()}`;
}

/** The lesson journal: lessons due for review first (got it / review again), then all of them by topic. */
export function LessonsPanel() {
  const qc = useQueryClient();
  const [topic, setTopic] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<LessonView>();
  const list = useQuery({ queryKey: queryKeys.lessons, queryFn: learnApi.lessons });
  const onSuccess = () => void qc.invalidateQueries({ queryKey: queryKeys.learn });
  const review = useMutation({
    mutationFn: ({ l, result }: { l: LessonView; result: LessonReviewResult }) =>
      learnApi.reviewLesson(l.id, result),
    onSuccess: (l) => {
      onSuccess();
      toast.success(`${l.topic}: ${reviewLabel(l).toLowerCase()}`);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (l: LessonView) => learnApi.deleteLesson(l.id),
    onSuccess: () => {
      onSuccess();
      setDeleting(undefined);
      toast.success('Lesson deleted');
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const all = list.data ?? [];
  const due = all
    .filter((l) => isDue(l.nextReviewAt))
    .sort((a, b) => (a.nextReviewAt ?? '').localeCompare(b.nextReviewAt ?? ''));
  const topics = [...new Set(all.map((l) => l.topic))].sort();
  const shown = topic ? all.filter((l) => l.topic === topic) : all;

  const card = (l: LessonView, reviewing: boolean) => (
    <li key={l.id} className="rounded-lg border bg-card p-3" aria-label={l.topic}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-sm font-semibold">#{l.topic}</h3>
          <p className="text-xs text-muted-foreground">
            {SOURCE_LABEL[l.source]} · {relativeTime(l.createdAt)} · reviewed {l.reviewedCount}× ·{' '}
            {reviewLabel(l)}
          </p>
        </div>
        {!reviewing && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete lesson ${l.topic}`}
            onClick={() => setDeleting(l)}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      <Markdown className="mt-2">{l.lessonMd}</Markdown>
      {l.whyItMattersMd.trim() && (
        <div className="mt-2 rounded-md bg-muted/50 p-2">
          <p className="text-xs font-semibold text-muted-foreground">Why it matters</p>
          <Markdown>{l.whyItMattersMd}</Markdown>
        </div>
      )}
      {reviewing && (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={review.isPending}
            onClick={() => review.mutate({ l, result: 'got_it' })}
          >
            <Check /> Got it
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={review.isPending}
            onClick={() => review.mutate({ l, result: 'again' })}
          >
            <RotateCcw /> Review again
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <section aria-label="Lessons" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 flex-wrap gap-1" role="group" aria-label="Filter by topic">
          {topics.length > 1 &&
            [undefined, ...topics].map((t) => (
              <button
                key={t ?? '*'}
                type="button"
                aria-pressed={topic === t}
                onClick={() => setTopic(t)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent',
                  topic === t && 'border-primary bg-primary/10 text-primary',
                )}
              >
                {t ? `#${t}` : 'All topics'}
              </button>
            ))}
        </div>
        <ExportLink path="/export/lessons" />
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> Add lesson
        </Button>
      </div>

      {list.isPending ? (
        <div className="h-24 animate-pulse rounded-lg border bg-muted/40" aria-busy="true" />
      ) : list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(list.error)}
        </p>
      ) : all.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No lessons yet"
          description="Takeaways worth remembering. Agent A adds them with add_lesson (more often with Explain mode on); you can add your own."
        />
      ) : (
        <>
          {due.length > 0 && (
            <section aria-label="Due for review" className="space-y-2">
              <h2 className="text-sm font-semibold">Due for review ({due.length})</h2>
              <ul className="space-y-2">{due.map((l) => card(l, true))}</ul>
            </section>
          )}
          <section aria-label="All lessons" className="space-y-2">
            <h2 className="text-sm font-semibold">All lessons</h2>
            <ul className="space-y-2">{shown.map((l) => card(l, false))}</ul>
          </section>
        </>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Add lesson"
        description="First review is due tomorrow, then after 3, 7 and 21 days."
      >
        {creating && (
          <LessonForm
            onDone={() => {
              onSuccess();
              setCreating(false);
            }}
          />
        )}
      </Dialog>

      <Dialog open={deleting !== undefined} onClose={() => setDeleting(undefined)} title="Delete lesson?">
        <p className="text-sm text-muted-foreground">
          The lesson on “{deleting?.topic}” is removed for good.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setDeleting(undefined)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={remove.isPending}
            onClick={() => deleting && remove.mutate(deleting)}
          >
            Delete
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function LessonForm({ onDone }: { onDone: () => void }) {
  const [topic, setTopic] = useState('');
  const [lessonMd, setLesson] = useState('');
  const [whyItMattersMd, setWhy] = useState('');
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: () => learnApi.createLesson({ topic, lessonMd, whyItMattersMd }),
    onSuccess: () => {
      toast.success('Lesson added');
      onDone();
    },
    onError: (err) => setError(errorText(err)),
  });

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!topic.trim() || !lessonMd.trim()) return setError('Give it a topic and the lesson');
    setError(undefined);
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Lesson">
      <Field label="Topic" htmlFor="lesson-topic" hint="One tag, e.g. testing or system-design.">
        <Input id="lesson-topic" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} />
      </Field>
      <Field label="Lesson" htmlFor="lesson-text" error={error} hint="Markdown.">
        <Textarea id="lesson-text" value={lessonMd} onChange={(e) => setLesson(e.target.value)} />
      </Field>
      <Field label="Why it matters" htmlFor="lesson-why">
        <Textarea id="lesson-why" rows={2} value={whyItMattersMd} onChange={(e) => setWhy(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={save.isPending}>
          Add
        </Button>
      </div>
    </form>
  );
}
