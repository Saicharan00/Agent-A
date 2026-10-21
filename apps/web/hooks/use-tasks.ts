'use client';

import type { TaskCreateRequest, TaskDetail, TaskPatchRequest, TaskView } from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { tasksApi } from '@/lib/tasks';
import { toast } from '@/lib/toast';

/** Task queries stay fresh through the live `task.changed` event (lib/live-cache.ts). */
export function useTasks() {
  return useQuery({ queryKey: queryKeys.taskList, queryFn: tasksApi.list });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: queryKeys.task(id ?? ''),
    enabled: !!id,
    queryFn: () => tasksApi.get(id!),
  });
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');

/** Create / patch / start / approve / request changes / remove; each refreshes the task queries and toasts on failure. */
export function useTaskActions() {
  const qc = useQueryClient();
  const onSuccess = (task: TaskDetail) => {
    qc.setQueryData(queryKeys.task(task.id), task);
    void qc.invalidateQueries({ queryKey: queryKeys.taskList });
  };
  const onError = (err: unknown) => {
    toast.error(errorText(err));
    void qc.invalidateQueries({ queryKey: queryKeys.tasks });
  };
  return {
    create: useMutation({ mutationFn: (b: TaskCreateRequest) => tasksApi.create(b), onSuccess }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: TaskPatchRequest }) => tasksApi.update(id, patch),
      // Optimistic: a dragged card lands in its new column at once.
      onMutate: ({ id, patch }) =>
        qc.setQueryData<TaskView[]>(queryKeys.taskList, (list) =>
          list?.map((t) => (t.id === id ? ({ ...t, ...patch } as TaskView) : t)),
        ),
      onSuccess,
      onError,
    }),
    start: useMutation({ mutationFn: tasksApi.start, onSuccess, onError }),
    approve: useMutation({ mutationFn: tasksApi.approve, onSuccess, onError }),
    requestChanges: useMutation({
      mutationFn: ({ id, feedback }: { id: string; feedback: string }) =>
        tasksApi.requestChanges(id, feedback),
      onSuccess,
      onError,
    }),
    remove: useMutation({
      mutationFn: tasksApi.remove,
      onSuccess: (_res, id) => {
        // Dropped, not invalidated: refetching a deleted task's detail would 404.
        qc.removeQueries({ queryKey: queryKeys.task(id) });
        void qc.invalidateQueries({ queryKey: queryKeys.taskList });
        void qc.invalidateQueries({ queryKey: queryKeys.goals });
      },
      onError,
    }),
  };
}
