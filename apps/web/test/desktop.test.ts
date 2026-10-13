import { describe, expect, it } from 'vitest';
import { describeDesktopStatus, desktopUrl } from '@/lib/desktop';

describe('desktop', () => {
  it('builds the proxied socket URL on the current origin', () => {
    expect(desktopUrl({ protocol: 'http:', host: 'localhost:3000' }, 'bot_a b')).toBe(
      'ws://localhost:3000/ws/desktop/bot_a%20b',
    );
    expect(desktopUrl({ protocol: 'https:', host: 'x.test' }, 'bot_a')).toBe('wss://x.test/ws/desktop/bot_a');
  });

  it('describes each state', () => {
    expect(describeDesktopStatus({ state: 'starting' })).toBe('Starting the computer…');
    expect(describeDesktopStatus({ state: 'connected' })).toBe('Connected');
    expect(describeDesktopStatus({ state: 'error' })).toBe('Could not reach the desktop');
    expect(describeDesktopStatus({ state: 'error', detail: 'Docker is down' })).toBe('Docker is down');
  });
});
