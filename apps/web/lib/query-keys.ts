// TanStack Query keys shared by fetchers and the live-event cache updater (lib/live-cache.ts).
// Lists live under a 'list' segment so invalidating them leaves cached details alone.
export const queryKeys = {
  runnerStatus: ['runner-status'] as const,
  engineAuth: ['settings', 'engines'] as const,
  engineState: ['engine-state'] as const,
  /** Prefix of every bot list; `botList` adds the archived filter. */
  bots: ['bots', 'list'] as const,
  botList: (archived: 'exclude' | 'include' | 'only' = 'exclude') => ['bots', 'list', archived] as const,
  bot: (id: string) => ['bots', 'detail', id] as const,
  threadMessages: (threadId: string) => ['threads', threadId, 'messages'] as const,
  runs: ['runs', 'list'] as const,
  run: (id: string) => ['runs', 'detail', id] as const,
};
