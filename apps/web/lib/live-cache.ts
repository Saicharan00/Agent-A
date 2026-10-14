import type { EngineQueueStateResponse, LiveEvent } from '@agenta/shared';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import type { RunnerStatus } from './runner';
import { type MessagesData, patchMessageContent, upsertMessage } from './threads';

type Cache = Pick<QueryClient, 'getQueryData' | 'setQueryData' | 'setQueriesData' | 'invalidateQueries'>;

type WithId = { id: string } & Record<string, unknown>;

/** Patches the item with `id` in a cached array (or a cached object with that id); false when it isn't cached. */
function patchCached(
  cache: Cache,
  key: readonly unknown[],
  id: string,
  patch: Record<string, unknown>,
): boolean {
  type T = WithId;
  const data = cache.getQueryData<T | T[]>(key);
  if (data === undefined) return false;
  if (Array.isArray(data)) {
    if (!data.some((x) => x.id === id)) return false;
    cache.setQueryData<T[]>(
      key,
      data.map((x) => (x.id === id ? { ...x, ...patch } : x)),
    );
    return true;
  }
  if (data.id !== id) return false;
  cache.setQueryData<T>(key, { ...data, ...patch });
  return true;
}

/**
 * Applies one live event to the TanStack Query cache: patches what the event fully describes, invalidates what it
 * only signals (a new message, a run list that changed). Run transcripts (`run.event`) are left to their consumers.
 */
export function applyLiveEvent(cache: Cache, event: LiveEvent): void {
  switch (event.type) {
    case 'engine.state': {
      const data = cache.getQueryData<EngineQueueStateResponse>(queryKeys.engineState);
      if (!data) {
        void cache.invalidateQueries({ queryKey: queryKeys.engineState });
        return;
      }
      const has = data.engines.some((e) => e.engine === event.engine);
      cache.setQueryData<EngineQueueStateResponse>(queryKeys.engineState, {
        ...data,
        engines: has
          ? data.engines.map((e) =>
              e.engine === event.engine ? { ...e, limitedUntil: event.limitedUntil } : e,
            )
          : [...data.engines, { engine: event.engine, limitedUntil: event.limitedUntil }],
      });
      return;
    }
    case 'docker.state': {
      const data = cache.getQueryData<RunnerStatus>(queryKeys.runnerStatus);
      if (data?.state !== 'ok') return; // the health poll recovers a runner that was down
      const { type: _type, ...docker } = event;
      const next: RunnerStatus = { ...data, health: { ...data.health, docker } };
      cache.setQueryData<RunnerStatus>(queryKeys.runnerStatus, next);
      return;
    }
    case 'bot.status':
      patchCached(cache, queryKeys.bot(event.botId), event.botId, { status: event.status });
      // Every cached bot list (any archived filter) under the ['bots', 'list'] prefix.
      cache.setQueriesData<WithId[]>({ queryKey: queryKeys.bots }, (list) =>
        Array.isArray(list)
          ? list.map((b) => (b.id === event.botId ? { ...b, status: event.status } : b))
          : list,
      );
      return;
    case 'bots.changed':
      void cache.invalidateQueries({ queryKey: queryKeys.bots });
      // Only that bot's detail, and not once deleted (a refetch would just 404; the entry ages out).
      if (event.change !== 'deleted') void cache.invalidateQueries({ queryKey: queryKeys.bot(event.botId) });
      return;
    case 'run.updated': {
      patchCached(cache, queryKeys.run(event.runId), event.runId, {
        status: event.status,
        error: event.error,
      });
      // Patch cached lists right away (chat states), then refetch them for timings and new runs.
      cache.setQueriesData<WithId[]>({ queryKey: queryKeys.runs }, (list) =>
        Array.isArray(list)
          ? list.map((r) => (r.id === event.runId ? { ...r, status: event.status, error: event.error } : r))
          : list,
      );
      void cache.invalidateQueries({ queryKey: queryKeys.runs });
      // A goal's run budget counts its runs.
      void cache.invalidateQueries({ queryKey: queryKeys.goals });
      return;
    }
    case 'message.updated':
    case 'message.created': {
      const key = queryKeys.threadMessages(event.threadId);
      const data = cache.getQueryData<MessagesData>(key);
      if (!data) return; // nobody is showing this thread
      const patched = patchMessageContent(data, event.messageId, event.contentMd);
      if (patched) {
        cache.setQueryData<MessagesData>(key, patched);
        return;
      }
      if (event.authorType && event.createdAt) {
        cache.setQueryData<MessagesData>(
          key,
          upsertMessage(data, {
            id: event.messageId,
            threadId: event.threadId,
            authorType: event.authorType,
            authorBotId: event.authorBotId,
            contentMd: event.contentMd,
            runId: event.runId,
            mentions: [],
            createdAt: event.createdAt,
          }),
        );
        return;
      }
      void cache.invalidateQueries({ queryKey: key });
      return;
    }
    case 'thread.activity':
      void cache.invalidateQueries({ queryKey: queryKeys.unread });
      // Members joining or leaving a group are announced by a system message.
      if (event.authorType === 'system') {
        void cache.invalidateQueries({ queryKey: queryKeys.thread(event.threadId) });
        void cache.invalidateQueries({ queryKey: queryKeys.groups });
      }
      return;
    case 'task.changed':
      // Lists and the open drawer; cheap at single-owner scale.
      void cache.invalidateQueries({ queryKey: queryKeys.tasks });
      // Goal progress counts done tasks.
      void cache.invalidateQueries({ queryKey: queryKeys.goals });
      return;
    case 'goal.changed':
      void cache.invalidateQueries({ queryKey: queryKeys.goals });
      return;
    case 'memory.changed':
      void cache.invalidateQueries({ queryKey: queryKeys.memories });
      return;
    case 'learn.changed':
      void cache.invalidateQueries({ queryKey: queryKeys.learn });
      return;
    case 'approval.changed':
      void cache.invalidateQueries({ queryKey: queryKeys.approvals });
      return;
    case 'schedule.changed':
      void cache.invalidateQueries({ queryKey: queryKeys.schedules });
      return;
    case 'run.event':
      return;
  }
}
