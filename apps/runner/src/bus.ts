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

  /** Returns an unsubscribe function. */
  subscribe(channel: string, listener: BusListener): () => void {
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
