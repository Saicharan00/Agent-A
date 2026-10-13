// TanStack Query keys shared by fetchers and the live-event cache updater (lib/live-cache.ts).
// Lists live under a 'list' segment so invalidating them leaves cached details alone.
export const queryKeys = {
  runnerStatus: ['runner-status'] as const,
  engineAuth: ['settings', 'engines'] as const,
  engineState: ['engine-state'] as const,
  bots: ['bots', 'list'] as const,
  bot: (id: string) => ['bots', 'detail', id] as const,
  threadMessages: (threadId: string) => ['threads', threadId, 'messages'] as const,
  runs: ['runs', 'list'] as const,
  run: (id: string) => ['runs', 'detail', id] as const,
};
