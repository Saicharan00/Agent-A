'use client';

import type {
  GroupCreateRequest,
  LiveEvent,
  RunView,
  SendMessageRequest,
  ThreadUpdateRequest,
  ThreadView,
  UnreadCounts,
} from '@agenta/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { useLiveChannel } from '@/hooks/use-live-channel';
import { ApiClientError, api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import {
  EMPTY_STREAM,
  type MessagesData,
  type RunStream,
  applyStreamEvent,
  isActiveRun,
  runEventsLoader,
  threadsApi,
  upsertMessage,
} from '@/lib/threads';
import { type Timeline, buildTimeline } from '@/lib/timeline';
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

/** The live events of a queued/running turn over `run:<id>`, replayed from the start (a reload shows it all). */
export function useRunStream(runId: string, active: boolean): RunStream {
  const [stream, dispatch] = useReducer(
    (s: RunStream, e: LiveEvent) => applyStreamEvent(s, runId, e),
    EMPTY_STREAM,
  );
  useLiveChannel(`run:${runId}`, { enabled: active, onEvent: dispatch });
  return stream;
}

/**
 * A bot turn's timeline: live while it runs, then the stored events (batched with the other visible turns). A turn
 * watched to its end keeps its live copy, so nothing is refetched when it finishes.
 */
export function useRunTimeline(run: RunView): { timeline: Timeline | null; loading: boolean } {
  const active = isActiveRun(run);
  const live = useRunStream(run.id, active);
  const liveDone = live.items.some((i) => i.event.type === 'run.finished');
  const stored = useQuery({
    queryKey: queryKeys.runEvents(run.id),
    queryFn: () => runEventsLoader.load(run.id),
    enabled: !active && !liveDone,
    staleTime: Infinity,
  });
  const items = active || liveDone ? live.items : stored.data;
  const timeline = useMemo(() => (items ? buildTimeline(items) : null), [items]);
  return { timeline, loading: !items && stored.isPending };
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

/** Rename / Explain mode. */
export function useUpdateThread(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ThreadUpdateRequest) => threadsApi.update(threadId, body),
    onSuccess: (thread) => {
      qc.setQueryData<ThreadView>(queryKeys.thread(threadId), thread);
      if (thread.kind === 'group') void qc.invalidateQueries({ queryKey: queryKeys.groups });
    },
    onError: (err) =>
      void toast.error(err instanceof Error ? err.message : 'Could not update the conversation'),
  });
}

/** Runs the latest finished turn again. */
export function useRetryTurn(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => threadsApi.retry(threadId, { runId }),
    onSuccess: (run) => {
      qc.setQueryData<RunView[]>(queryKeys.threadRuns(threadId), (list) =>
        list && !list.some((r) => r.id === run.id) ? [run, ...list] : list,
      );
      void qc.invalidateQueries({ queryKey: queryKeys.runs });
    },
    onError: (err) => void toast.error(err instanceof Error ? err.message : 'Could not retry'),
  });
}

/** Unseen messages per thread (sidebar badges); refreshed on every `thread.activity`. */
export function useUnreadCounts() {
  return useQuery({ queryKey: queryKeys.unread, queryFn: () => threadsApi.unread() });
}

/**
 * Marks the thread read while it is open and visible: on open, whenever a new message arrives, and when the tab
 * becomes visible again.
 */
export function useMarkRead(threadId: string, latestMessageId: string | undefined, enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const mark = () => {
      if (document.visibilityState !== 'visible') return;
      qc.setQueryData<UnreadCounts>(queryKeys.unread, (u) => {
        if (!u?.counts[threadId]) return u;
        const { [threadId]: _seen, ...counts } = u.counts;
        return { counts };
      });
      // Refetch afterwards: a count fetched while the read was in flight may still include this thread.
      threadsApi
        .markRead(threadId)
        .then(() => qc.invalidateQueries({ queryKey: queryKeys.unread }))
        .catch(() => undefined); // best effort; the badge just stays
    };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [qc, threadId, latestMessageId, enabled]);
}

// ---------- group chats (F18) ----------

export function useGroups() {
  return useQuery({ queryKey: queryKeys.groups, queryFn: () => threadsApi.groups() });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GroupCreateRequest) => threadsApi.createGroup(body),
    onSuccess: (thread) => {
      qc.setQueryData<ThreadView>(queryKeys.thread(thread.id), thread);
      void qc.invalidateQueries({ queryKey: queryKeys.groups });
    },
  });
}

/** Add or remove a group member. */
export function useGroupMember(threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ botId, action }: { botId: string; action: 'add' | 'remove' }) =>
      action === 'add' ? threadsApi.addMember(threadId, botId) : threadsApi.removeMember(threadId, botId),
    onSuccess: (thread) => {
      qc.setQueryData<ThreadView>(queryKeys.thread(threadId), thread);
      void qc.invalidateQueries({ queryKey: queryKeys.groups });
    },
    onError: (err) => void toast.error(err instanceof Error ? err.message : 'Could not update the members'),
  });
}
