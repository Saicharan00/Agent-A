'use client';

import type { GoalCreateRequest, GoalView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { goalsApi } from '@/lib/goals';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

/** Goal queries stay fresh through the live `goal.changed` and `task.changed` events (lib/live-cache.ts). */
export function useGoals() {
  return useQuery({ queryKey: queryKeys.goalList, queryFn: goalsApi.list });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** Create / confirm / pause / resume; each refreshes the goal queries and toasts on failure. */
export function useGoalActions() {
  const qc = useQueryClient();
  const onSuccess = () => void qc.invalidateQueries({ queryKey: queryKeys.goals });
  const onError = (err: unknown) => toast.error(errorText(err));
  return {
    create: useMutation({ mutationFn: (b: GoalCreateRequest) => goalsApi.create(b), onSuccess }),
    confirm: useMutation({ mutationFn: goalsApi.confirm, onSuccess, onError }),
    pause: useMutation({ mutationFn: goalsApi.pause, onSuccess, onError }),
    resume: useMutation({ mutationFn: goalsApi.resume, onSuccess, onError }),
  };
}

/** The goal whose thread this is, if any. */
export function useGoalOfThread(threadId: string, enabled: boolean): GoalView | undefined {
  const goals = useQuery({ queryKey: queryKeys.goalList, queryFn: goalsApi.list, enabled });
  return goals.data?.find((g) => g.threadId === threadId);
}
