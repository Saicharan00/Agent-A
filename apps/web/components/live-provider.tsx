'use client';

import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { applyLiveEvent } from '@/lib/live-cache';
import { defaultLiveUrl, LiveConnection, type LiveStatus } from '@/lib/live-channel';

const LiveContext = createContext<LiveConnection | null>(null);

/**
 * Owns the tab's single live connection. Every event updates the TanStack Query cache; after a reconnect all
 * queries are refetched (only run channels replay what was missed). `global` stays subscribed for the top bar.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connection] = useState(() =>
    typeof window === 'undefined'
      ? null
      : new LiveConnection({
          url: defaultLiveUrl(window.location),
          onEvent: (_channel, event) => applyLiveEvent(queryClient, event),
          onReconnect: () => void queryClient.invalidateQueries(),
        }),
  );

  useEffect(() => {
    if (!connection) return;
    const offGlobal = connection.subscribe('global', () => undefined);
    connection.start();
    return () => {
      offGlobal();
      connection.stop();
    };
  }, [connection]);

  return <LiveContext.Provider value={connection}>{children}</LiveContext.Provider>;
}

export function useLiveConnection(): LiveConnection | null {
  return useContext(LiveContext);
}

/** Connection status of the tab's live socket ('idle' during SSR / before mount). */
export function useLiveStatus(): LiveStatus {
  const connection = useLiveConnection();
  return useSyncExternalStore(
    (cb) => connection?.onStatus(cb) ?? (() => undefined),
    () => connection?.currentStatus ?? 'idle',
    () => 'idle',
  );
}
