import type { EngineQueueStateResponse, LiveEvent } from '@agenta/shared';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import type { RunnerStatus } from './runner';

type Cache = Pick<QueryClient, 'getQueryData' | 'setQueryData' | 'invalidateQueries'>;

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
      patchCached(cache, queryKeys.bots, event.botId, { status: event.status });
      return;
    case 'run.updated':
      patchCached(cache, queryKeys.run(event.runId), event.runId, {
        status: event.status,
        error: event.error,
      });
      void cache.invalidateQueries({ queryKey: queryKeys.runs });
      return;
    case 'message.updated':
      if (
        patchCached(cache, queryKeys.threadMessages(event.threadId), event.messageId, {
          contentMd: event.contentMd,
        })
      )
        return;
      void cache.invalidateQueries({ queryKey: queryKeys.threadMessages(event.threadId) });
      return;
    case 'message.created':
      void cache.invalidateQueries({ queryKey: queryKeys.threadMessages(event.threadId) });
      return;
    case 'run.event':
      return;
  }
}
