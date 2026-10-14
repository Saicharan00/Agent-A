'use client';

import { useMutation } from '@tanstack/react-query';
import { CalendarCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { learnApi } from '@/lib/learn';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { BriefsPanel } from './briefs-panel';
import { DecisionsPanel } from './decisions-panel';
import { LessonsPanel } from './lessons-panel';
import { WorkSplitPanel } from './work-split-panel';

const TABS = [
  { id: 'decisions', label: 'Decisions', Panel: DecisionsPanel },
  { id: 'lessons', label: 'Lessons', Panel: LessonsPanel },
  { id: 'work-split', label: 'Work split', Panel: WorkSplitPanel },
  { id: 'briefs', label: 'Briefs', Panel: BriefsPanel },
] as const;

/** The /learn tabs. */
export function LearnView() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('decisions');
  const { Panel } = TABS.find((t) => t.id === tab)!;
  const router = useRouter();
  const review = useMutation({
    mutationFn: learnApi.weeklyReview,
    onSuccess: (r) => {
      toast.success('Agent A is writing your weekly review');
      router.push(`/threads/${r.threadId}`);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Something went wrong'),
  });
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="outline"
          disabled={review.isPending}
          onClick={() => review.mutate()}
          title="Agent A summarizes the week and adds 5 review questions, due today"
        >
          <CalendarCheck /> Weekly review
        </Button>
      </div>
      <div role="tablist" aria-label="Learn" className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`learn-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="learn-panel"
            onClick={() => setTab(t.id)}
            className={cn(
              '-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground',
              tab === t.id && 'border-primary font-medium text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="learn-panel" aria-labelledby={`learn-tab-${tab}`}>
        <Panel />
      </div>
    </div>
  );
}
