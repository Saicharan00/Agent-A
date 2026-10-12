'use client';

import { useEffect, useRef, useState } from 'react';
import { defaultLiveUrl, LiveChannelClient, type LiveStatus } from '@/lib/live-channel';

/**
 * Subscribes to a runner channel (`run:<id>`, `thread:<id>`, `bot:<id>`, `global`) and reconnects
 * automatically. Skeleton: the server side and wire protocol arrive in F11, so pass `enabled: false`
 * (the default) until then to avoid connection attempts.
 */
export function useLiveChannel(
  channel: string | null,
  opts: { enabled?: boolean; url?: string; onEvent?: (event: unknown) => void } = {},
): { status: LiveStatus; lastEvent: unknown } {
  const { enabled = false, url } = opts;
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [lastEvent, setLastEvent] = useState<unknown>(undefined);
  const onEventRef = useRef(opts.onEvent);
  useEffect(() => {
    onEventRef.current = opts.onEvent;
  });

  useEffect(() => {
    if (!enabled || !channel) return;
    const client = new LiveChannelClient({
      url: url ?? defaultLiveUrl(window.location),
      channel,
      onStatus: setStatus,
      onMessage: ({ event }) => {
        setLastEvent(event);
        onEventRef.current?.(event);
      },
    });
    client.start();
    return () => client.stop();
  }, [channel, enabled, url]);

  return { status, lastEvent };
}
