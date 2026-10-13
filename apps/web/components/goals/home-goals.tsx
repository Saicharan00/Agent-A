'use client';

import { Target } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { useBots } from '@/hooks/use-bots';
import { useGoals } from '@/hooks/use-goals';
import { GoalCard } from './goal-progress';
import { NewGoalForm } from './new-goal-form';

/** Home: start a goal for Agent A and follow every goal's progress. */
export function HomeGoals() {
  const bots = useBots();
  const goals = useGoals();
  const hasLead = bots.data?.some((b) => b.isLead);
  return (
    <section className="space-y-4" aria-label="Goals">
      {bots.data && !hasLead ? (
        <EmptyState
          icon={Target}
          title="No lead bot yet"
          description="Goals are planned by Agent A, the team lead. Set up the Agent A team to start one."
        />
      ) : (
        <NewGoalForm />
      )}
      {goals.data && goals.data.length > 0 && (
        <ul className="space-y-3" aria-label="Goal list">
          {goals.data.map((g) => (
            <GoalCard key={g.id} goal={g} />
          ))}
        </ul>
      )}
    </section>
  );
}
