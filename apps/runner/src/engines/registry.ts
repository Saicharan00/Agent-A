import type { Engine } from '@agenta/shared';
import type { EngineAdapter } from './types';

export class EngineNotAvailableError extends Error {
  readonly code = 'engine_unavailable';
  constructor(readonly engine: Engine) {
    super(`The ${engine} engine is not available in this runner`);
  }
}

/**
 * Picks the adapter for a bot. `override: 'mock'` (AGENTA_ENGINE_OVERRIDE=mock, set by Playwright) forces every
 * bot onto the mock engine so no test can reach a real CLI.
 */
export class EngineRegistry {
  private readonly adapters = new Map<Engine, EngineAdapter>();

  constructor(
    adapters: EngineAdapter[],
    private readonly override?: 'mock',
  ) {
    for (const a of adapters) this.adapters.set(a.id, a);
  }

  /** The engine a bot actually runs on. */
  effectiveEngine(bot: { engine: Engine }): Engine {
    return this.override ?? bot.engine;
  }

  get(bot: { engine: Engine }): EngineAdapter {
    const engine = this.effectiveEngine(bot);
    const adapter = this.adapters.get(engine);
    if (!adapter) throw new EngineNotAvailableError(engine);
    return adapter;
  }

  has(engine: Engine): boolean {
    return this.adapters.has(engine);
  }
}
