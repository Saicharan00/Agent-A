import type { HealthResponse, LiveDockerState } from '@agenta/shared';
import type { EventBus } from '../bus';

type DockerHealth = NonNullable<HealthResponse['docker']>;

/**
 * Polls Docker reachability and publishes `docker.state` on `global` whenever it changes (ok/down, image
 * present/missing), so the top-bar pill flips without waiting for the UI's own health poll.
 */
export class DockerMonitor {
  private timer: NodeJS.Timeout | undefined;
  private last: string | undefined;
  private checking = false;

  constructor(
    private readonly opts: {
      bus: EventBus;
      health: () => Promise<DockerHealth>;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.opts.intervalMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll; publishes only on change. Exposed for tests. */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const h = await this.opts.health();
      const key = `${h.ok}|${h.image ?? ''}|${h.ok ? (h.version ?? '') : ''}`;
      if (key === this.last) return;
      this.last = key;
      const event: LiveDockerState = { type: 'docker.state', ...h };
      this.opts.bus.publish('global', event);
    } finally {
      this.checking = false;
    }
  }
}
