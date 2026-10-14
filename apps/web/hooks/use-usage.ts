'use client';

import type { UsageSettings } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';
import { usageApi } from '@/lib/usage';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The report refreshes on live run and goal events (lib/live-cache.ts) and every 30 s for the 24-hour windows. */
export function useUsage(days: number) {
  return useQuery({
    queryKey: queryKeys.usageReport(days),
    queryFn: () => usageApi.report(days, browserZone()),
    refetchInterval: 30_000,
  });
}

export function useUsageSettings() {
  return useQuery({ queryKey: queryKeys.usageSettings, queryFn: usageApi.settings });
}

export function useUsageActions() {
  const qc = useQueryClient();
  const onSuccess = () => void qc.invalidateQueries({ queryKey: queryKeys.usage });
  const onError = (err: unknown) => toast.error(err instanceof Error ? err.message : 'Something went wrong');
  return {
    saveSettings: useMutation({
      mutationFn: (b: UsageSettings) => usageApi.saveSettings(b),
      onSuccess: () => {
        onSuccess();
        toast.success('Usage settings saved');
      },
      onError,
    }),
    setGoalBudget: useMutation({
      mutationFn: ({ id, maxRuns }: { id: string; maxRuns: number }) => usageApi.setGoalBudget(id, maxRuns),
      onSuccess: () => {
        onSuccess();
        void qc.invalidateQueries({ queryKey: queryKeys.goals });
      },
      onError,
    }),
  };
}
