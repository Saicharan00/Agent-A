import { EventEmitter } from 'node:events';

// In-process pub/sub keyed by channel (`bot:<id>`, `run:<id>`, …). F11 fans these out over WebSocket.

export type BusListener = (event: unknown) => void;

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(channel: string, event: unknown): void {
    this.emitter.emit(channel, event);
  }

  /** How many listeners a channel has (a browser tab watching `thread:<id>` counts as one). */
  listenerCount(channel: string): number {
    return this.emitter.listenerCount(channel);
  }

  /** Returns an unsubscribe function. */
  subscribe(channel: string, listener: BusListener): () => void {
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
