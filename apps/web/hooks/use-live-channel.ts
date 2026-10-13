'use client';

import type { LiveEvent } from '@agenta/shared';
import { useEffect, useRef, useState } from 'react';
import { useLiveConnection, useLiveStatus } from '@/components/live-provider';
import type { LiveStatus } from '@/lib/live-channel';

/**
 * Listens on a runner channel (`run:<id>`, `thread:<id>`, `bot:<id>`, `global`) over the tab's shared live socket.
 * The cache side effects (bot status, messages, run status) happen in LiveProvider whatever `onEvent` does.
 * Run channels replay from `afterSeq` (default: the whole run) and survive reconnects without gaps or repeats.
 */
export function useLiveChannel(
  channel: string | null,
  opts: { enabled?: boolean; afterSeq?: number; onEvent?: (event: LiveEvent) => void } = {},
): { status: LiveStatus; lastEvent: LiveEvent | undefined } {
  const { enabled = true, afterSeq } = opts;
  const connection = useLiveConnection();
  const status = useLiveStatus();
  const [lastEvent, setLastEvent] = useState<LiveEvent | undefined>(undefined);
  const onEventRef = useRef(opts.onEvent);
  useEffect(() => {
    onEventRef.current = opts.onEvent;
  });
  // afterSeq only matters for the first subscribe; later changes must not resubscribe.
  const afterSeqRef = useRef(afterSeq);

  useEffect(() => {
    if (!enabled || !channel || !connection) return;
    return connection.subscribe(
      channel,
      (event) => {
        setLastEvent(event);
        onEventRef.current?.(event);
      },
      { afterSeq: afterSeqRef.current },
    );
  }, [channel, enabled, connection]);

  return { status, lastEvent };
}
