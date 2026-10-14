'use client';

import type { ScheduleCreateRequest, ScheduleUpdateRequest } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { schedulesApi } from '@/lib/schedules';
import { toast } from '@/lib/toast';

/** Schedule queries stay fresh through the live `schedule.changed` event (lib/live-cache.ts). */
export function useSchedules() {
  return useQuery({ queryKey: queryKeys.scheduleList, queryFn: schedulesApi.list });
}

export function useScheduleHistory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.scheduleHistory(id),
    queryFn: () => schedulesApi.history(id),
    enabled,
    // Run statuses change while a run goes; no schedule event marks that.
    refetchInterval: enabled ? 5_000 : false,
  });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** Create / update / delete / Run now; each refreshes the schedule queries. Create and update report errors inline. */
export function useScheduleActions() {
  const qc = useQueryClient();
  const onSuccess = () => void qc.invalidateQueries({ queryKey: queryKeys.schedules });
  const onError = (err: unknown) => toast.error(errorText(err));
  return {
    create: useMutation({ mutationFn: (b: ScheduleCreateRequest) => schedulesApi.create(b), onSuccess }),
    update: useMutation({
      mutationFn: ({ id, ...b }: ScheduleUpdateRequest & { id: string }) => schedulesApi.update(id, b),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: schedulesApi.delete, onSuccess, onError }),
    runNow: useMutation({ mutationFn: schedulesApi.runNow, onSuccess, onError }),
  };
}
