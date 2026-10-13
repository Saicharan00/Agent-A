'use client';

import type { LiveEvent, RunView, SendMessageRequest } from '@agenta/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useReducer } from 'react';
import { useLiveChannel } from '@/hooks/use-live-channel';
import { ApiClientError, api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  EMPTY_STREAM,
  type MessagesData,
  type RunStream,
  applyStreamEvent,
  threadsApi,
  upsertMessage,
} from '@/lib/threads';
import { toast } from '@/lib/toast';

const notFound = (err: unknown) => err instanceof ApiClientError && err.status === 404;

export function useThread(id: string) {
  return useQuery({
    queryKey: queryKeys.thread(id),
    queryFn: () => threadsApi.get(id),
    retry: (n, err) => !notFound(err) && n < 2,
  });
}

/** History, newest page first; `fetchNextPage` loads older messages. Live events keep the newest page current. */
export function useThreadMessages(id: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.threadMessages(id),
    queryFn: ({ pageParam }) => threadsApi.messages(id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.id : undefined),
    retry: (n, err) => !notFound(err) && n < 2,
  });
}

/** The thread's recent runs (newest first), patched live by run.updated. */
export function useThreadRuns(id: string) {
  return useQuery({ queryKey: queryKeys.threadRuns(id), queryFn: () => threadsApi.runs(id) });
}

/** Usage-limit pauses per engine (shared with the top-bar pills). */
export function useEngineState() {
  return useQuery({ queryKey: queryKeys.engineState, queryFn: () => api.engineState() });
}

/**
 * Live text of one bot turn. While the run is queued or running it follows `run:<id>`, which replays everything
 * from the start first, so a reload mid-run shows the full reply so far.
 */
export function useRunStream(runId: string, active: boolean): RunStream {
  const [stream, dispatch] = useReducer(
    (s: RunStream, e: LiveEvent) => applyStreamEvent(s, runId, e),
    EMPTY_STREAM,
  );
  useLiveChannel(`run:${runId}`, { enabled: active, onEvent: dispatch });
  return stream;
}

export function useSendMessage(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SendMessageRequest) => threadsApi.send(threadId, body),
    onSuccess: ({ message, runs }) => {
      // Show it at once; the live message.created / run.updated events are idempotent with this.
      qc.setQueryData<MessagesData>(queryKeys.threadMessages(threadId), (data) =>
        data ? upsertMessage(data, message) : data,
      );
      qc.setQueryData<RunView[]>(queryKeys.threadRuns(threadId), (list) =>
        list ? [...runs.filter((r) => !list.some((x) => x.id === r.id)), ...list] : list,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.runs });
    },
  });
}

/** Stops runs (Stop button): queued ones are dropped, running ones interrupted. */
export function useCancelRuns() {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (runIds: string[]) =>
      Promise.allSettled(runIds.map((id) => threadsApi.cancelRun(id))).then((results) => {
        // A run that finished meanwhile answers 409: nothing left to stop, not an error.
        const failed = results.find(
          (r): r is PromiseRejectedResult =>
            r.status === 'rejected' && !(r.reason instanceof ApiClientError && r.reason.status === 409),
        );
        if (failed) throw failed.reason;
      }),
    onError: (err) => void toast.error(err instanceof Error ? err.message : 'Could not stop the run'),
    onSettled: () => void qc.invalidateQueries({ queryKey: queryKeys.runs }),
  });
  const stop = useCallback((runIds: string[]) => cancel.mutate(runIds), [cancel]);
  return { stop, pending: cancel.isPending };
}
