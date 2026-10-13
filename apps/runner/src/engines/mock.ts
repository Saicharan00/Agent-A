import type { EngineEvent, RunFinishStatus } from '@agenta/shared';
import type { EngineAdapter, EngineRunInput } from './types';

// Scripted engine for tests and e2e: realistic event streams without spending subscription usage.
// The scenario is picked by a keyword in the prompt: [mock:hello] [mock:tools] [mock:error] [mock:limit]
// [mock:slow] [mock:delegate] [mock:browser] [mock:moderate]; anything else echoes the prompt.

export const MOCK_SCENARIOS = [
  'hello',
  'tools',
  'error',
  'limit',
  'slow',
  'delegate',
  'browser',
  'moderate',
  'echo',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

/** Time source. Tests inject a fake whose sleep resolves immediately and advances `now`. */
export type MockClock = {
  now(): Date;
  /** Resolves after `ms`, or rejects with an AbortError when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export const realClock: MockClock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

/** A clock that never waits: `sleep` advances virtual time. */
export function fakeClock(start = new Date('2026-01-01T00:00:00.000Z')): MockClock & { elapsedMs(): number } {
  let t = start.getTime();
  const t0 = t;
  return {
    now: () => new Date(t),
    sleep: async (ms, signal) => {
      if (signal.aborted) throw abortError();
      t += ms;
      await Promise.resolve();
      if (signal.aborted) throw abortError();
    },
    elapsedMs: () => t - t0,
  };
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** The Platform MCP tools (F17), called as the bot whose turn this is. Unset: the mock answers with a stub. */
export type MockPlatform = { call(name: string, input: unknown, botId: string): Promise<string> };

export type MockEngineOptions = {
  clock?: MockClock;
  /** Delay between streamed deltas. Default 25 ms (fast e2e, still visibly streaming). */
  tickMs?: number;
  /** Total duration of [mock:slow]. Default 20 s. */
  slowMs?: number;
  platform?: MockPlatform;
};

export function pickScenario(prompt: string): MockScenario {
  const m = /\[mock:([a-z]+)\]/i.exec(prompt);
  const name = m?.[1]?.toLowerCase();
  return (MOCK_SCENARIOS as readonly string[]).includes(name ?? '') ? (name as MockScenario) : 'echo';
}

/** Splits text into word-sized deltas that concatenate back to the original. */
export function wordChunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

type Emit = (e: EngineEvent) => void;

export class MockEngine implements EngineAdapter {
  readonly id = 'mock' as const;
  private readonly clock: MockClock;
  private readonly tickMs: number;
  private readonly slowMs: number;

  constructor(private readonly opts: MockEngineOptions = {}) {
    this.clock = opts.clock ?? realClock;
    this.tickMs = opts.tickMs ?? 25;
    this.slowMs = opts.slowMs ?? 20_000;
  }

  async *run(input: EngineRunInput, signal: AbortSignal): AsyncGenerator<EngineEvent> {
    // Deterministic session id: one session per (bot, thread), like the real engines' resume.
    const sessionId = input.resumeSessionId ?? `mock-${input.bot.id}-${input.threadId}`;
    const queue: EngineEvent[] = [];
    const emit: Emit = (e) => queue.push(e);
    const scenario = pickScenario(input.prompt);
    let status: RunFinishStatus;

    yield { type: 'run.started', engine: 'mock', sessionId };
    const steps = this.script(scenario, input, emit);
    try {
      for (;;) {
        if (signal.aborted) throw abortError();
        const step = await steps.next();
        while (queue.length) yield queue.shift()!;
        if (step.done) {
          status = step.value;
          break;
        }
        await this.clock.sleep(step.value, signal);
      }
    } catch (err) {
      while (queue.length) yield queue.shift()!;
      if ((err as Error).name !== 'AbortError') {
        yield { type: 'error', message: `Mock engine crashed: ${(err as Error).message}` };
        status = 'failed';
      } else {
        status = 'cancelled';
      }
    }
    yield { type: 'run.finished', status, sessionId };
  }

  /** One Platform MCP tool call with its result (or a stub when no platform is connected). */
  private async *platformCall(
    callId: string,
    call: { name: string; input: unknown },
    input: EngineRunInput,
    emit: Emit,
  ): AsyncGenerator<number> {
    emit({ type: 'tool.call', callId, ...call });
    yield this.tickMs * 2;
    let output: string;
    let isError = false;
    try {
      output = this.opts.platform
        ? await this.opts.platform.call(call.name, call.input, input.bot.id)
        : 'Platform MCP is not connected; call recorded by the mock engine.';
    } catch (err) {
      output = (err as Error).message;
      isError = true;
    }
    emit({ type: 'tool.result', callId, output, ...(isError ? { isError } : {}) });
    yield this.tickMs;
  }

  /** Each scenario emits events and yields the delay (ms) before its next step; returns the final status. */
  private async *script(
    scenario: MockScenario,
    input: EngineRunInput,
    emit: Emit,
  ): AsyncGenerator<number, RunFinishStatus> {
    const tick = this.tickMs;
    function* stream(text: string): Generator<number> {
      for (const chunk of wordChunks(text)) {
        emit({ type: 'text.delta', text: chunk });
        yield tick;
      }
    }
    const usage = (text: string) =>
      emit({
        type: 'usage',
        inputTokens: Math.ceil(input.prompt.length / 4),
        outputTokens: Math.ceil(text.length / 4),
        costUsdEquivalent: 0,
      });
    const reply = function* (text: string): Generator<number> {
      yield* stream(text);
      emit({ type: 'text.final', text });
      usage(text);
    };

    switch (scenario) {
      case 'hello': {
        yield* reply(`Hello! I'm ${input.bot.name}, running on the mock engine. How can I help?`);
        return 'succeeded';
      }
      case 'tools': {
        emit({ type: 'thinking', text: 'I should look at the work folder, then write a file.' });
        yield tick;
        const intro = 'Let me check the workspace first. ';
        yield* stream(intro);
        emit({
          type: 'tool.call',
          callId: 'mock-call-1',
          name: 'Bash',
          input: { command: 'ls -la /home/bot/work' },
        });
        yield tick * 2;
        emit({
          type: 'tool.result',
          callId: 'mock-call-1',
          output: 'total 8\ndrwxr-xr-x 2 bot bot 4096 . \ndrwxr-xr-x 9 bot bot 4096 ..',
        });
        yield tick;
        const path = '/home/bot/work/hello.txt';
        emit({
          type: 'tool.call',
          callId: 'mock-call-2',
          name: 'Write',
          input: { file_path: path, content: 'hello from mock\n' },
        });
        yield tick * 2;
        emit({ type: 'tool.result', callId: 'mock-call-2', output: `File created successfully at: ${path}` });
        emit({ type: 'file.changed', path, change: 'created' });
        yield tick;
        const done = 'The folder was empty, so I created hello.txt with a greeting.';
        yield* stream(done);
        emit({ type: 'text.final', text: intro + done });
        usage(intro + done);
        return 'succeeded';
      }
      case 'browser': {
        // The Playwright MCP calls a real engine makes for "open example.com" (the mock never touches the desktop).
        const intro = 'Opening the page in the browser. ';
        yield* stream(intro);
        emit({
          type: 'tool.call',
          callId: 'mock-browser-1',
          name: 'mcp__playwright__browser_navigate',
          input: { url: 'https://example.com/' },
        });
        yield tick * 2;
        emit({
          type: 'tool.result',
          callId: 'mock-browser-1',
          output: '### Page state\n- Page URL: https://example.com/\n- Page Title: Example Domain',
        });
        yield tick;
        const done = 'The page title is "Example Domain".';
        yield* stream(done);
        emit({ type: 'text.final', text: intro + done });
        usage(intro + done);
        return 'succeeded';
      }
      case 'error': {
        yield* stream('Starting the work… ');
        emit({
          type: 'error',
          message: 'Mock engine failure (scripted [mock:error])',
          raw: '{"error":"scripted"}',
        });
        return 'failed';
      }
      case 'limit': {
        const resetsAt = new Date(this.clock.now().getTime() + 2 * 60_000).toISOString();
        emit({
          type: 'limit.hit',
          engine: 'mock',
          resetsAt,
          raw: `Mock usage limit reached; resets at ${resetsAt}`,
        });
        return 'limited';
      }
      case 'slow': {
        const steps = Math.max(1, Math.round(this.slowMs / 1000));
        for (let i = 1; i <= steps; i++) {
          emit({ type: 'text.delta', text: i === 1 ? 'Working slowly.' : '.' });
          yield this.slowMs / steps;
        }
        const text = `Working slowly.${'.'.repeat(steps - 1)} Done after ${Math.round(this.slowMs / 1000)} s.`;
        emit({ type: 'text.delta', text: ` Done after ${Math.round(this.slowMs / 1000)} s.` });
        emit({ type: 'text.final', text });
        usage(text);
        return 'succeeded';
      }
      case 'delegate': {
        const calls: { name: string; input: unknown }[] = [
          {
            name: 'mcp__agenta__create_task',
            input: { title: 'Mock subtask', description: 'Created by [mock:delegate]', assignee: 'self' },
          },
          {
            name: 'mcp__agenta__ask_bot',
            input: { bot: 'agent-a', message: 'I created a subtask for this.' },
          },
        ];
        const intro = 'I will split this up and tell the team. ';
        yield* stream(intro);
        for (const [i, call] of calls.entries())
          yield* this.platformCall(`mock-mcp-${i + 1}`, call, input, emit);
        const done = 'Delegated: one subtask created and Agent A notified.';
        yield* stream(done);
        emit({ type: 'text.final', text: intro + done });
        usage(intro + done);
        return 'succeeded';
      }
      case 'moderate': {
        // As the group's moderator, hand the message to the first other member (listed in the prompt) via ask_bot.
        const target = input.prompt.includes('You moderate this group')
          ? /^- .+ \(@([a-z0-9-]+)\)(?!.*\[[^\]]*\byou\b)/m.exec(input.prompt)?.[1]
          : undefined;
        if (!target) {
          yield* reply('I am not moderating a group here, so there is nobody to hand this to.');
          return 'succeeded';
        }
        // No @ here: the ask_bot call is the hand-over (a mention would start a second turn).
        const intro = `${target} is best placed for this; asking them. `;
        yield* stream(intro);
        yield* this.platformCall(
          'mock-mcp-1',
          {
            name: 'mcp__agenta__ask_bot',
            input: { bot: target, message: 'Could you take this one?', thread_id: input.threadId },
          },
          input,
          emit,
        );
        const done = 'Handed over.';
        yield* stream(done);
        emit({ type: 'text.final', text: intro + done });
        usage(intro + done);
        return 'succeeded';
      }
      case 'echo': {
        // A multi-line prompt (e.g. a group turn) is quoted, so the @mentions in it don't trigger anyone again.
        const said = input.prompt.includes('\n')
          ? `\n\n${input.prompt.replace(/^/gm, '> ')}`
          : ` ${input.prompt}`;
        yield* reply(`You said:${said}`);
        return 'succeeded';
      }
    }
  }
}
