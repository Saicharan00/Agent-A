import type { RunsRepo } from '@agenta/db';
import type { EngineEvent, LiveRunEvent } from '@agenta/shared';
import type { EventBus } from '../bus';

/** Events that end a step the UI should show at once: written without waiting for the batch window. */
const FLUSH_NOW = new Set<EngineEvent['type']>(['text.final', 'tool.call', 'tool.result', 'run.finished']);

/**
 * Persists one run's events to run_events in small batches and publishes each on `run:<id>` only after its
 * transaction committed. The DB is therefore never behind the bus: a WebSocket client (F11) that subscribes
 * first and then replays `afterSeq` from the DB sees every event, de-duplicating by `seq`.
 */
export class RunEventWriter {
  private buffer: EngineEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private lastSeq = 0;

  constructor(
    private readonly runs: RunsRepo,
    private readonly bus: EventBus,
    private readonly runId: string,
    private readonly flushMs = 50,
  ) {}

  /** Sequence number of the last event written so far. */
  get seq(): number {
    return this.lastSeq;
  }

  push(event: EngineEvent): void {
    this.buffer.push(event);
    if (FLUSH_NOW.has(event.type) || this.flushMs <= 0) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const rows = this.runs.appendEvents(
      this.runId,
      batch.map((e) => ({ type: e.type, payload: e })),
    );
    for (const [i, row] of rows.entries()) {
      this.lastSeq = row.seq;
      const live: LiveRunEvent = {
        type: 'run.event',
        runId: this.runId,
        seq: row.seq,
        event: batch[i]!,
        createdAt: row.createdAt,
      };
      this.bus.publish(`run:${this.runId}`, live);
    }
  }
}
