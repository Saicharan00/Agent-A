'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Textarea, invalidProps } from '@/components/ui/form';
import { useGoalActions } from '@/hooks/use-goals';

/** Anchor the command palette's "New goal" opens (/#new-goal). */
export const NEW_GOAL_ANCHOR = 'new-goal';
const GOAL_INPUT_ID = 'goal-text';

export function focusNewGoal(): void {
  document.getElementById(GOAL_INPUT_ID)?.focus();
}

/** The owner's goal for Agent A: what, constraints, and whether Agent A may start without confirmation. */
export function NewGoalForm() {
  const router = useRouter();
  const { create } = useGoalActions();
  const [goalMd, setGoalMd] = useState('');
  const [constraintsMd, setConstraintsMd] = useState('');
  const [autoRun, setAutoRun] = useState(false);
  const [error, setError] = useState<string>();
  const goalRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (window.location.hash === `#${NEW_GOAL_ANCHOR}`) goalRef.current?.focus();
  }, []);

  function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!goalMd.trim()) return setError('Describe the goal');
    setError(undefined);
    create.mutate(
      { goalMd, constraintsMd, autoRun },
      {
        onSuccess: (goal) => router.push(`/threads/${goal.threadId}`),
        onError: (err) => setError(err instanceof Error ? err.message : 'Could not start the goal'),
      },
    );
  }

  return (
    <form
      id={NEW_GOAL_ANCHOR}
      onSubmit={submit}
      aria-label="New goal"
      className="space-y-3 rounded-xl border bg-card p-4"
    >
      <h2 className="text-base font-semibold">New goal</h2>
      <Field
        label="Goal"
        htmlFor={GOAL_INPUT_ID}
        error={error}
        hint="Agent A restates it, plans tasks for the team and asks you to confirm."
      >
        <Textarea
          id={GOAL_INPUT_ID}
          ref={goalRef}
          value={goalMd}
          onChange={(e) => setGoalMd(e.target.value)}
          placeholder="e.g. Build a landing page for my side project with a waitlist form"
          {...invalidProps(GOAL_INPUT_ID, error)}
        />
      </Field>
      <Field
        label="Constraints"
        htmlFor="goal-constraints"
        hint="Work from non-confidential descriptions only: no company secrets, credentials or private data."
      >
        <Textarea
          id="goal-constraints"
          className="min-h-16"
          value={constraintsMd}
          onChange={(e) => setConstraintsMd(e.target.value)}
          placeholder="Deadlines, tech to use or avoid, budget…"
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
          Auto-run: start the tasks without asking me to confirm the plan
        </label>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Starting…' : 'Start goal'}
        </Button>
      </div>
    </form>
  );
}
