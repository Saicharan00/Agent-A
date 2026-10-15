import type { EngineEvent } from '@agenta/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockEngine } from '../../src/engines/mock';
import type { EngineAdapter, EngineRunInput } from '../../src/engines/types';
import { RUNNER_RESTARTED, RUNNER_STOPPED, RunError } from '../../src/runs/service';
import { GateEngine, type Harness, makeHarness, sharedClock } from './helpers';

const types = (h: Harness, runId: string) => h.repos.runs.listEvents(runId).map((e) => e.type);
const seqs = (h: Harness, runId: string) => h.repos.runs.listEvents(runId).map((e) => e.seq);
const contiguous = (s: number[]) => s.every((v, i) => v === i + 1);

describe('RunService (session 2: cancel, timeout, limits, recovery, retries)', () => {
  let h: Harness;
  afterEach(() => h.close());

  describe('cancel', () => {
    it('cancels a queued run without starting it', async () => {
      h = makeHarness();
      const botId = h.bot('A', 'claude');
      h.service.enqueue({ botId, trigger: 'user', prompt: 'first' });
      const second = h.service.enqueue({ botId, trigger: 'user', prompt: 'second' });
      await h.gate.whenRunning(1);

      const cancelled = await h.service.cancel(second.id);
      expect(cancelled).toMatchObject({ status: 'cancelled', startedAt: null, error: null });
      expect(types(h, second.id)).toEqual(['run.finished']);

      h.gate.release('first');
      await h.service.idle();
      expect(h.gate.started.map((i) => i.prompt)).toEqual(['first']);
    });

    it('stops a running run promptly and records it as cancelled', async () => {
      h = makeHarness({ adapters: [new MockEngine({ slowMs: 60_000 })] });
      const botId = h.bot('Slow');
      const threadId = h.dm(botId);
      const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: '[mock:slow]' });
      await vi.waitFor(() => expect(types(h, run.id)).toContain('text.delta'));

      const t0 = Date.now();
      const after = await h.service.cancel(run.id);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(after).toMatchObject({ status: 'cancelled', error: null });
      expect(after.finishedAt).not.toBeNull();
      expect(h.repos.runs.listEvents(run.id).at(-1)?.payload).toMatchObject({
        type: 'run.finished',
        status: 'cancelled',
      });
      expect(contiguous(seqs(h, run.id))).toBe(true);
      expect(h.repos.messages.getByRun(run.id)).toBeUndefined();
    });

    it('rejects unknown and finished runs', async () => {
      h = makeHarness();
      const botId = h.bot('Echo');
      const run = h.service.enqueue({ botId, trigger: 'user', prompt: 'hi' });
      await h.service.idle();
      await expect(h.service.cancel(run.id)).rejects.toMatchObject({ code: 'run_finished', statusCode: 409 });
      await expect(h.service.cancel('run_missing')).rejects.toBeInstanceOf(RunError);
    });
  });

  describe('timeout', () => {
    it('stops a run that exceeds its time limit and fails it', async () => {
      h = makeHarness({ defaultTimeoutMs: 40 });
      const botId = h.bot('Stuck', 'claude');
      const run = h.service.enqueue({ botId, trigger: 'user', prompt: 'never ends' });
      await h.service.idle();
      const done = h.repos.runs.get(run.id)!;
      expect(done.status).toBe('failed');
      expect(done.error).toMatch(/^Timed out after/);
      expect(types(h, run.id).slice(-2)).toEqual(['error', 'run.finished']);
      expect(h.gate.running()).toEqual([]);
    });

    it("uses the bot's own time limit over the default", async () => {
      h = makeHarness({ defaultTimeoutMs: 20 });
      const botId = h.repos.bots.create({
        name: 'Patient',
        engine: 'claude',
        settings: { runTimeoutMin: 5 },
      }).id;
      const run = h.service.enqueue({ botId, trigger: 'user', prompt: 'long job' });
      await h.gate.whenRunning(1);
      await new Promise((r) => setTimeout(r, 80));
      expect(h.repos.runs.get(run.id)!.status).toBe('running');
      h.gate.release('long job');
      await h.service.idle();
      expect(h.repos.runs.get(run.id)!.status).toBe('succeeded');
    });
  });

  describe('usage limits', () => {
    it('pauses the engine, notifies, and re-runs the turn once after the (fake) reset', async () => {
      const clock = sharedClock();
      h = makeHarness({ now: clock.now, adapters: [new MockEngine({ clock: clock.mock, tickMs: 1 })] });
      const botId = h.bot('Limited');
      const threadId = h.dm(botId);
      const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: '[mock:limit] do it' });
      await h.service.idle();

      const limited = h.repos.runs.get(run.id)!;
      expect(limited.status).toBe('limited');
      expect(limited.error).toBe('Usage limit reached; mock paused until 2026-10-13T10:02:00.000Z');
      expect(h.repos.engineState.get('mock')?.limitedUntil).toBe('2026-10-13T10:02:00.000Z');
      expect(types(h, run.id)).toEqual(['run.started', 'limit.hit', 'system', 'run.finished']);
      expect(h.published).toContainEqual({
        channel: 'global',
        event: { type: 'engine.state', engine: 'mock', limitedUntil: '2026-10-13T10:02:00.000Z' },
      });
      const [note] = h.repos.notifications.list();
      expect(note).toMatchObject({
        kind: 'engine.limited',
        title: 'Mock engine usage limit reached',
        link: '/usage',
      });
      expect(note!.body).toContain('will run again automatically');

      const retry = h.repos.runs.list({ status: 'queued' })[0]!;
      expect(retry).toMatchObject({
        retryOfRunId: run.id,
        botId,
        threadId,
        prompt: '[mock:limit] do it',
        trigger: 'user',
      });

      // Still paused: nothing starts, however often the scheduler ticks.
      clock.advance(60_000);
      await h.service.idle();
      expect(h.repos.runs.get(retry.id)!.status).toBe('queued');

      // After the reset the retry runs; it hits the limit again and is not retried a second time.
      clock.advance(61_000);
      await h.service.idle();
      expect(h.published).toContainEqual({
        channel: 'global',
        event: { type: 'engine.state', engine: 'mock', limitedUntil: null },
      });
      expect(h.repos.runs.get(retry.id)!.status).toBe('limited');
      expect(h.repos.runs.list()).toHaveLength(2);
      expect(h.repos.notifications.list()[0]!.body).toContain('will not be retried');
    });

    it('a goal run whose retry the goal refuses says why, in the timeline and the notification', async () => {
      const clock = sharedClock();
      h = makeHarness({ now: clock.now, adapters: [new MockEngine({ clock: clock.mock, tickMs: 1 })] });
      const botId = h.bot('Lead');
      const threadId = h.dm(botId);
      const goal = h.repos.goals.create({
        title: 'Ship it',
        slug: 'ship-it',
        goalMd: 'Ship it',
        maxRuns: 1,
        leadBotId: botId,
        threadId,
      });
      const run = h.service.enqueue({
        botId,
        threadId,
        goalId: goal.id,
        trigger: 'user',
        prompt: '[mock:limit] go',
      });
      await h.service.idle();

      expect(h.repos.runs.get(run.id)!.status).toBe('limited');
      expect(h.repos.runs.list({ status: 'queued' })).toEqual([]);
      const system = h.repos.runs.listEvents(run.id).find((e) => e.type === 'system');
      expect(JSON.stringify(system)).toContain(
        'This turn was not queued again: The goal \\"Ship it\\" has used all 1',
      );
      expect(h.repos.notifications.list()[0]!.body).toContain(
        'will not be retried: The goal "Ship it" has used all 1',
      );
    });

    it('pauses for 30 minutes when the limit message has no reset time, and lets other engines run', async () => {
      const clock = sharedClock();
      h = makeHarness({ now: clock.now });
      const gateBot = h.bot('Gate', 'claude');
      const mockBot = h.bot('Mocky');
      const run = h.service.enqueue({ botId: gateBot, trigger: 'user', prompt: 'busy' });
      await h.gate.whenRunning(1);
      h.gate.release('busy', [{ type: 'limit.hit', engine: 'claude', raw: "You've hit your limit" }]);
      await h.service.idle();
      expect(h.repos.runs.get(run.id)!.status).toBe('limited');
      expect(h.repos.engineState.get('claude')).toMatchObject({
        limitedUntil: '2026-10-13T10:30:00.000Z',
        lastError: "You've hit your limit",
      });

      const other = h.service.enqueue({ botId: mockBot, trigger: 'user', prompt: 'hello' });
      await h.service.idle();
      expect(h.repos.runs.get(other.id)!.status).toBe('succeeded');
      expect(h.gate.started).toHaveLength(1);
    });
  });

  describe('restart recovery', () => {
    it('fails runs a previous process left running, then runs the queue', async () => {
      h = makeHarness();
      const botId = h.bot('Echo');
      const orphan = h.repos.runs.create({ botId, trigger: 'user', engine: 'mock', prompt: 'x' });
      h.repos.runs.markRunning(orphan.id);
      h.repos.runs.appendEvent(orphan.id, 'run.started', { type: 'run.started', engine: 'mock' });
      const queued = h.repos.runs.create({ botId, trigger: 'user', engine: 'mock', prompt: 'later' });

      h.service.start();
      expect(h.repos.runs.get(orphan.id)).toMatchObject({ status: 'failed', error: RUNNER_RESTARTED });
      expect(types(h, orphan.id)).toEqual(['run.started', 'error', 'run.finished']);
      expect(contiguous(seqs(h, orphan.id))).toBe(true);

      await vi.waitFor(() => expect(h.repos.runs.get(queued.id)!.status).toBe('succeeded'));
    });

    it('fails running runs on graceful shutdown', async () => {
      h = makeHarness();
      const botId = h.bot('Gate', 'claude');
      const run = h.service.enqueue({ botId, trigger: 'user', prompt: 'mid-flight' });
      await h.gate.whenRunning(1);
      await h.service.shutdown(1000);
      expect(h.repos.runs.get(run.id)).toMatchObject({ status: 'failed', error: RUNNER_STOPPED });
    });
  });

  describe('transient retries', () => {
    it('retries once when the computer fails to start transiently', async () => {
      let calls = 0;
      h = makeHarness({
        retryDelayMs: 1,
        prepare: async () => {
          if (++calls === 1)
            throw Object.assign(new Error('Could not start the computer: boom'), { code: 'start_failed' });
          return () => undefined;
        },
      });
      const botId = h.bot('Echo');
      const threadId = h.dm(botId);
      const run = h.service.enqueue({ botId, threadId, trigger: 'user', prompt: 'hi' });
      await h.service.idle();
      expect(calls).toBe(2);
      expect(h.repos.runs.get(run.id)).toMatchObject({ status: 'succeeded', error: null });
      expect(types(h, run.id).slice(0, 3)).toEqual(['error', 'system', 'run.started']);
      expect(h.repos.messages.getByRun(run.id)?.contentMd).toBe('You said: hi');
    });

    it('gives up after the second transient failure, and never retries permanent ones', async () => {
      let calls = 0;
      h = makeHarness({
        retryDelayMs: 1,
        prepare: async (bot) => {
          calls++;
          if (bot.name === 'Flaky') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
          throw Object.assign(new Error('The agenta-bot:latest image is missing'), {
            code: 'image_missing',
            statusCode: 409,
          });
        },
      });
      const flaky = h.service.enqueue({ botId: h.bot('Flaky'), trigger: 'user', prompt: 'x' });
      await h.service.idle();
      expect(calls).toBe(2);
      expect(h.repos.runs.get(flaky.id)).toMatchObject({ status: 'failed', error: 'socket hang up' });

      calls = 0;
      const broken = h.service.enqueue({ botId: h.bot('Broken'), trigger: 'user', prompt: 'x' });
      await h.service.idle();
      expect(calls).toBe(1);
      expect(h.repos.runs.get(broken.id)!.error).toMatch(/image is missing/);
    });

    it('retries once when the engine CLI could not be started (exec_failed)', async () => {
      let attempts = 0;
      const flaky: EngineAdapter = {
        id: 'claude',
        async *run(input: EngineRunInput): AsyncGenerator<EngineEvent> {
          attempts++;
          yield { type: 'run.started', engine: 'claude' };
          if (attempts === 1) {
            yield {
              type: 'error',
              message: 'Could not run Claude Code: no such container',
              code: 'exec_failed',
            };
            yield { type: 'run.finished', status: 'failed' };
            return;
          }
          yield { type: 'text.final', text: `ok ${input.prompt}` };
          yield { type: 'run.finished', status: 'succeeded', sessionId: 's1' };
        },
      };
      h = makeHarness({ retryDelayMs: 1, adapters: [flaky] });
      const run = h.service.enqueue({ botId: h.bot('C', 'claude'), trigger: 'user', prompt: 'go' });
      await h.service.idle();
      expect(attempts).toBe(2);
      expect(h.repos.runs.get(run.id)!.status).toBe('succeeded');
      expect(types(h, run.id)).toEqual([
        'run.started',
        'error',
        'system',
        'run.started',
        'text.final',
        'run.finished',
      ]);
    });

    it('does not retry engine failures that are not exec failures', async () => {
      h = makeHarness({ retryDelayMs: 1 });
      const botId = h.bot('Gate', 'claude');
      const run = h.service.enqueue({ botId, trigger: 'user', prompt: 'bad' });
      await h.gate.whenRunning(1);
      h.gate.release('bad', [{ type: 'error', message: 'API Error: 500' }]);
      await h.service.idle();
      expect(h.gate.started).toHaveLength(1);
      expect(h.repos.runs.get(run.id)).toMatchObject({ status: 'failed', error: 'API Error: 500' });
    });
  });

  it('GateEngine sanity: cancel during a run ends it as cancelled', async () => {
    h = makeHarness({ adapters: [new GateEngine('claude')] });
    const run = h.service.enqueue({ botId: h.bot('G', 'claude'), trigger: 'user', prompt: 'p' });
    await vi.waitFor(() => expect(h.repos.runs.get(run.id)!.status).toBe('running'));
    expect((await h.service.cancel(run.id)).status).toBe('cancelled');
  });
});
