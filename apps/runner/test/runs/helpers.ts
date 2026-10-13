import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import type { Engine, EngineEvent, LiveEvent } from '@agenta/shared';
import { EventBus } from '../../src/bus';
import { type MockClock, MockEngine, fakeClock } from '../../src/engines/mock';
import { EngineRegistry } from '../../src/engines/registry';
import type { EngineAdapter, EngineRunInput } from '../../src/engines/types';
import { RunService, type RunServiceOptions } from '../../src/runs/service';

export const silent = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * An engine whose runs block until the test releases them, so tests can observe what runs concurrently.
 * Registered under any engine id ('claude' by default) so limit tests can pause it independently of mock.
 */
export class GateEngine implements EngineAdapter {
  readonly started: EngineRunInput[] = [];
  private readonly waiting = new Map<string, { resolve: (events: EngineEvent[]) => void }>();
  private readonly listeners: (() => void)[] = [];

  constructor(readonly id: Engine = 'claude') {}

  /** Prompts of the runs currently blocked in the engine. */
  running(): string[] {
    return [...this.waiting.keys()];
  }

  /** Finishes the run with this prompt, emitting `events` (default: a reply) then run.finished. */
  release(prompt: string, events?: EngineEvent[]): void {
    const w = this.waiting.get(prompt);
    if (!w) throw new Error(`No run waiting for "${prompt}" (running: ${this.running().join(', ')})`);
    this.waiting.delete(prompt);
    w.resolve(events ?? [{ type: 'text.final', text: `done: ${prompt}` }]);
  }

  /** Resolves once `n` runs are blocked in the engine. */
  async whenRunning(n: number): Promise<void> {
    while (this.waiting.size < n) await new Promise<void>((r) => this.listeners.push(r));
  }

  async *run(input: EngineRunInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    this.started.push(input);
    yield { type: 'run.started', engine: this.id, sessionId: input.resumeSessionId ?? `s-${input.prompt}` };
    const events = await new Promise<EngineEvent[] | null>((resolve) => {
      this.waiting.set(input.prompt, { resolve });
      signal.addEventListener('abort', () => {
        this.waiting.delete(input.prompt);
        resolve(null);
      });
      for (const l of this.listeners.splice(0)) l();
    });
    if (!events) {
      yield { type: 'run.finished', status: 'cancelled' };
      return;
    }
    yield* events;
    const failed = events.some((e) => e.type === 'error');
    const limited = events.some((e) => e.type === 'limit.hit');
    yield {
      type: 'run.finished',
      status: limited ? 'limited' : failed ? 'failed' : 'succeeded',
      sessionId: input.resumeSessionId ?? `s-${input.prompt}`,
    };
  }
}

/** One virtual clock shared by the service (limit checks) and the mock engine (reset times); sleeps are instant. */
export function sharedClock(start = '2026-10-13T10:00:00.000Z') {
  let t = Date.parse(start);
  const now = () => new Date(t);
  const mock: MockClock = {
    now,
    sleep: async (_ms, signal) => {
      await Promise.resolve();
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
  };
  return { now, mock, advance: (ms: number) => void (t += ms) };
}

export type Harness = {
  dir: string;
  db: Db;
  repos: Repos;
  bus: EventBus;
  service: RunService;
  gate: GateEngine;
  /** Everything published on the bus, with its channel. */
  published: { channel: string; event: LiveEvent }[];
  bot(name: string, engine?: Engine): string;
  dm(botId: string): string;
  close(): void;
};

export function makeHarness(opts: Partial<RunServiceOptions> & { adapters?: EngineAdapter[] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agenta-runs-'));
  const db = openDb(join(dir, 'test.db'));
  const repos = createRepos(db);
  const bus = new EventBus();
  const published: Harness['published'] = [];
  const origPublish = bus.publish.bind(bus);
  bus.publish = (channel, event) => {
    published.push({ channel, event: event as LiveEvent });
    origPublish(channel, event);
  };
  const gate = new GateEngine('claude');
  const adapters = opts.adapters ?? [new MockEngine({ clock: fakeClock(), tickMs: 1 }), gate];
  const service = new RunService({
    repos,
    bus,
    engines: new EngineRegistry(adapters),
    log: silent,
    flushMs: 0,
    ...opts,
  });
  let n = 0;
  return {
    dir,
    db,
    repos,
    bus,
    service,
    gate,
    published,
    bot: (name, engine = 'mock') =>
      repos.bots.create({ name, slug: `${name.toLowerCase()}-${++n}`, engine }).id,
    dm: (botId) => {
      const t = repos.threads.create({ kind: 'dm', title: 'DM' });
      repos.threads.addMember(t.id, botId);
      return t.id;
    },
    close: () => {
      service.stop();
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
