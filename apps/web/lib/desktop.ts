// The Desktop tab (F16): noVNC through the runner's /ws/desktop/:botId proxy (never the container port directly).

export type DesktopState = 'starting' | 'connecting' | 'connected' | 'disconnected' | 'error';
export type DesktopStatus = { state: DesktopState; detail?: string };

/** ws(s)://<host>/ws/desktop/<botId> on the current origin (Next proxies it to the runner). */
export function desktopUrl(location: { protocol: string; host: string }, botId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/desktop/${encodeURIComponent(botId)}`;
}

export function describeDesktopStatus(s: DesktopStatus): string {
  switch (s.state) {
    case 'starting':
      return 'Starting the computer…';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    case 'error':
      return s.detail ?? 'Could not reach the desktop';
  }
}
