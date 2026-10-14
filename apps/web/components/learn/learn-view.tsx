'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { DecisionsPanel } from './decisions-panel';
import { LessonsPanel } from './lessons-panel';

const TABS = [
  { id: 'decisions', label: 'Decisions', Panel: DecisionsPanel },
  { id: 'lessons', label: 'Lessons', Panel: LessonsPanel },
] as const;

/** The /learn tabs. */
export function LearnView() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('decisions');
  const { Panel } = TABS.find((t) => t.id === tab)!;
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Learn" className="flex gap-1 border-b">
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
