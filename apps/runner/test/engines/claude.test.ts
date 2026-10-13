import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { type EngineEvent, engineEventSchema } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { ClaudeEngine, ClaudeStreamMapper, buildClaudeArgs } from '../../src/engines/claude';
import type { EngineLauncher, EngineProcess, EngineSpawn } from '../../src/engines/process';
import type { EngineRunInput } from '../../src/engines/types';
import { FAKE_CLAUDE_TOKEN } from './helpers';

const NOW = new Date('2026-10-13T10:00:00.000Z');
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8');
const lines = (name: string): unknown[] =>
  fixture(name)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

function mapFixture(name: string, exitCode = 0, stderr = '') {
  const m = new ClaudeStreamMapper(() => NOW);
  const events = lines(name).flatMap((l) => m.map(l));
  const done = m.finish(exitCode, stderr);
  return { mapper: m, events: [...events, ...done.events], status: done.status };
}

const types = (es: EngineEvent[]) => es.map((e) => e.type);

describe('ClaudeStreamMapper (fixtures)', () => {
  it('text: streams deltas, then the final message and usage', () => {
    const { events, status, mapper } = mapFixture('text');
    expect(status).toBe('succeeded');
    expect(mapper.sessionId).toBe('11111111-2222-4333-8444-555555555555');
    expect(types(events)).toEqual(['text.delta', 'text.final', 'usage']);
    expect(events[1]).toEqual({ type: 'text.final', text: 'DONE' });
    expect(events[2]).toMatchObject({ type: 'usage', outputTokens: expect.any(Number) });
  });

  it('tools: tool call + result + file.changed, then text', () => {
    const { events, status } = mapFixture('tools');
    expect(status).toBe('succeeded');
    const noDeltas = events.filter((e) => e.type !== 'text.delta');
    expect(types(noDeltas)).toEqual(['tool.call', 'tool.result', 'file.changed', 'text.final', 'usage']);
    const call = noDeltas[0] as Extract<EngineEvent, { type: 'tool.call' }>;
    expect(call).toMatchObject({
      name: 'Write',
      input: { file_path: '/home/bot/work/hello.txt', content: 'hi\n' },
    });
    expect(noDeltas[1]).toMatchObject({ type: 'tool.result', callId: call.callId });
    expect((noDeltas[1] as { isError?: boolean }).isError).toBeUndefined();
    expect(noDeltas[2]).toEqual({
      type: 'file.changed',
      path: '/home/bot/work/hello.txt',
      change: 'created',
    });
    // usage = input + cache creation + cache read; cost from total_cost_usd
    const usage = noDeltas[4] as Extract<EngineEvent, { type: 'usage' }>;
    expect(usage.inputTokens).toBeGreaterThan(1000);
    expect(usage.costUsdEquivalent).toBeCloseTo(0.0266658);
    for (const e of events) engineEventSchema.parse(e);
  });

  it('error: one error event from the API error message, status failed', () => {
    const { events, status } = mapFixture('error', 1);
    expect(status).toBe('failed');
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: expect.stringContaining("Can't reach the API server") });
    expect(events.some((e) => e.type === 'text.final')).toBe(false);
  });

  it('limit: one limit.hit with the reset time from rate_limit_event, status limited', () => {
    const { events, status } = mapFixture('limit', 1);
    expect(status).toBe('limited');
    expect(types(events)).toEqual(['limit.hit']);
    expect(events[0]).toMatchObject({
      type: 'limit.hit',
      engine: 'claude',
      resetsAt: new Date(1791900000 * 1000).toISOString(),
    });
  });

  it('limit text without rate_limit_event: parses the wall-clock reset time', () => {
    const rows = lines('limit').filter((l) => (l as { type: string }).type !== 'rate_limit_event');
    const m = new ClaudeStreamMapper(() => NOW);
    const events = rows.flatMap((l) => m.map(l));
    expect(events).toEqual([
      {
        type: 'limit.hit',
        engine: 'claude',
        resetsAt: '2026-10-13T15:00:00.000Z',
        raw: "You've hit your limit · resets 3pm (UTC)",
      },
    ]);
    expect(m.finish(1).status).toBe('limited');
  });

  it('resume-missing: flags the missing session and emits no error', () => {
    const { events, status, mapper } = mapFixture('resume-missing', 1);
    expect(mapper.resumeMissing).toBe(true);
    expect(status).toBe('failed');
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('ignores sub-agent text, keeps sub-agent tool calls, and maps Edit to modified', () => {
    const m = new ClaudeStreamMapper();
    const sub = { parent_tool_use_id: 'toolu_parent', session_id: 's' };
    expect(
      m.map({
        type: 'stream_event',
        ...sub,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
      }),
    ).toEqual([]);
    expect(
      m.map({ type: 'assistant', ...sub, message: { content: [{ type: 'text', text: 'sub reply' }] } }),
    ).toEqual([]);
    const call = m.map({
      type: 'assistant',
      ...sub,
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/home/bot/a.ts' } }],
      },
    });
    expect(call).toEqual([
      { type: 'tool.call', callId: 't1', name: 'Edit', input: { file_path: '/home/bot/a.ts' } },
    ]);
    expect(
      m.map({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }],
        },
      }),
    ).toEqual([
      { type: 'tool.result', callId: 't1', output: 'ok' },
      { type: 'file.changed', path: '/home/bot/a.ts', change: 'modified' },
    ]);
  });

  it('a failed tool result is an error result and no file change', () => {
    const m = new ClaudeStreamMapper();
    m.map({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/x' } }] },
    });
    expect(
      m.map({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'denied', is_error: true }] },
      }),
    ).toEqual([{ type: 'tool.result', callId: 't2', output: 'denied', isError: true }]);
  });

  it('thinking blocks and a replayed string prompt', () => {
    const m = new ClaudeStreamMapper();
    expect(
      m.map({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    ).toEqual([{ type: 'thinking', text: 'hmm' }]);
    expect(m.map({ type: 'user', message: { role: 'user', content: 'hello' } })).toEqual([]);
    expect(m.map('not an object')).toEqual([]);
  });

  it('exit without a result: error with the last stderr line, failed', () => {
    const m = new ClaudeStreamMapper();
    const done = m.finish(2, 'some noise\nError: Invalid model name\n');
    expect(done.status).toBe('failed');
    expect(done.events).toEqual([
      {
        type: 'error',
        message: 'Claude Code exited with code 2 without a result: Error: Invalid model name',
        raw: 'some noise\nError: Invalid model name',
      },
    ]);
  });

  it('resume failure reported only on stderr is detected too', () => {
    const m = new ClaudeStreamMapper();
    const done = m.finish(1, 'No conversation found with session ID: abc\n');
    expect(m.resumeMissing).toBe(true);
    expect(done.events).toEqual([]);
  });
});

describe('buildClaudeArgs', () => {
  it('new session: --session-id; resume: --resume; optional model, system prompt file, MCP config', () => {
    expect(buildClaudeArgs({ sessionId: 's1', resume: false })).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--session-id',
      's1',
    ]);
    const args = buildClaudeArgs({
      sessionId: 's2',
      resume: true,
      model: 'sonnet',
      systemPromptFile: '/home/bot/.agenta/runs/x/system.md',
      mcpConfigPath: '/home/bot/.agenta/mcp.json',
    });
    expect(args.slice(7)).toEqual([
      '--resume',
      's2',
      '--model',
      'sonnet',
      '--append-system-prompt-file',
      '/home/bot/.agenta/runs/x/system.md',
      '--mcp-config',
      '/home/bot/.agenta/mcp.json',
    ]);
    expect(args).not.toContain('--bare');
  });
});

// ---------- adapter with a fake launcher (no Docker, no CLI) ----------

type Behavior = (p: FakeProcess) => void;

class FakeProcess implements EngineProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  disposed = false;
  private resolveExit!: (code: number) => void;
  private readonly exit = new Promise<number>((r) => (this.resolveExit = r));
  exited = false;
  onSignal?: (sig: 'INT' | 'KILL') => void;

  constructor(readonly spec: EngineSpawn) {}

  write(rows: unknown[] | string): void {
    this.stdout.write(typeof rows === 'string' ? rows : rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  end(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.resolveExit(code);
  }
  wait(): Promise<number> {
    return this.exit;
  }
  async signal(sig: 'INT' | 'KILL'): Promise<void> {
    this.signals.push(sig);
    this.onSignal?.(sig);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeLauncher implements EngineLauncher {
  readonly procs: FakeProcess[] = [];
  readonly files = new Map<string, string>();
  readonly existing = new Set<string>();
  constructor(private readonly behaviors: Behavior[]) {}

  async spawn(_botId: string, spec: EngineSpawn): Promise<EngineProcess> {
    const p = new FakeProcess(spec);
    this.procs.push(p);
    const behavior = this.behaviors[this.procs.length - 1];
    if (!behavior) throw new Error('container is not running');
    setImmediate(() => behavior(p));
    return p;
  }
  writeHomeFile(_botId: string, relPath: string, content: string): string {
    this.files.set(relPath, content);
    return `/home/bot/${relPath}`;
  }
  removeHomeFile(_botId: string, relPath: string): void {
    for (const k of [...this.files.keys()]) if (k.startsWith(relPath)) this.files.delete(k);
  }
  homeFileExists(_botId: string, containerPath: string): boolean {
    return this.existing.has(containerPath);
  }
}

const silent = { debug() {}, warn() {} };

const runInput = (over: Partial<EngineRunInput> = {}): EngineRunInput => ({
  bot: { id: 'bot_1', name: 'Coder', slug: 'coder', role: '', engine: 'claude', model: 'sonnet' },
  threadId: 'thr_1',
  prompt: 'Create hello.txt containing hi, then reply DONE',
  systemPromptAppend: 'You are Coder.',
  mcpConfigPath: '/home/bot/.agenta/mcp.json',
  cwd: '/home/bot/work',
  ...over,
});

function engineWith(behaviors: Behavior[], opts: { killGraceMs?: number } = {}) {
  const launcher = new FakeLauncher(behaviors);
  const engine = new ClaudeEngine({
    launcher,
    env: () => ({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_TOKEN }),
    log: silent,
    killGraceMs: opts.killGraceMs ?? 30,
    closeGraceMs: 30,
    now: () => NOW,
  });
  return { engine, launcher };
}

async function collect(engine: ClaudeEngine, input: EngineRunInput, signal = new AbortController().signal) {
  const events: EngineEvent[] = [];
  for await (const e of engine.run(input, signal)) events.push(engineEventSchema.parse(e));
  return events;
}

const replay =
  (name: string, code = 0, stderr = ''): Behavior =>
  (p) => {
    p.write(fixture(name));
    if (stderr) p.stderr.write(stderr);
    p.end(code);
  };

describe('ClaudeEngine', () => {
  it('runs one turn: prompt on stdin, token + DISPLAY in exec env, run files cleaned up', async () => {
    let filesDuringRun: string[] = [];
    const { engine, launcher } = engineWith([
      (p) => {
        filesDuringRun = [...launcher.files.keys()];
        replay('tools')(p);
      },
    ]);
    const events = await collect(engine, runInput());
    expect(events[0]).toMatchObject({ type: 'run.started', engine: 'claude' });
    const started = events[0] as Extract<EngineEvent, { type: 'run.started' }>;
    expect(events.at(-1)).toEqual({
      type: 'run.finished',
      status: 'succeeded',
      sessionId: '11111111-2222-4333-8444-555555555555',
    });
    const spec = launcher.procs[0]!.spec;
    expect(spec.cmd).toContain('--session-id');
    expect(spec.cmd[spec.cmd.indexOf('--session-id') + 1]).toBe(started.sessionId);
    expect(spec.cmd).toEqual(expect.arrayContaining(['--model', 'sonnet', '--append-system-prompt-file']));
    expect(spec.cmd).not.toContain('--mcp-config'); // the file doesn't exist yet
    expect(spec.cmd.join(' ')).not.toContain('hello.txt'); // prompt is not in argv
    expect(spec.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_TOKEN, DISPLAY: ':99' });
    expect(spec.workdir).toBe('/home/bot/work');
    expect(spec.stdinFile).toMatch(/^\/home\/bot\/\.agenta\/runs\/[0-9a-f-]+\/prompt\.md$/);
    expect(filesDuringRun.sort()).toEqual([
      expect.stringMatching(/prompt\.md$/),
      expect.stringMatching(/system\.md$/),
    ]);
    expect(launcher.files.size).toBe(0);
    expect(launcher.procs[0]!.signals).toEqual([]);
    expect(launcher.procs[0]!.disposed).toBe(true);
  });

  it('passes --mcp-config when the file exists, and --resume for a known session', async () => {
    const { engine, launcher } = engineWith([replay('text')]);
    launcher.existing.add('/home/bot/.agenta/mcp.json');
    const events = await collect(engine, runInput({ resumeSessionId: 'sess-old', model: 'opus' }));
    const cmd = launcher.procs[0]!.spec.cmd;
    expect(cmd).toEqual(
      expect.arrayContaining(['--resume', 'sess-old', '--mcp-config', '/home/bot/.agenta/mcp.json']),
    );
    expect(cmd[cmd.indexOf('--model') + 1]).toBe('opus');
    expect(events[0]).toEqual({ type: 'run.started', engine: 'claude', sessionId: 'sess-old' });
  });

  it('resume of a vanished session: retries once without --resume and emits a system note', async () => {
    const { engine, launcher } = engineWith([replay('resume-missing', 1), replay('text')]);
    const events = await collect(engine, runInput({ resumeSessionId: 'sess-gone' }));
    expect(launcher.procs).toHaveLength(2);
    expect(launcher.procs[0]!.spec.cmd).toEqual(expect.arrayContaining(['--resume', 'sess-gone']));
    expect(launcher.procs[1]!.spec.cmd).toContain('--session-id');
    expect(launcher.procs[1]!.spec.cmd).not.toContain('--resume');
    expect(types(events)).toEqual([
      'run.started',
      'system',
      'text.delta',
      'text.final',
      'usage',
      'run.finished',
    ]);
    expect(events[1]).toMatchObject({ type: 'system', message: expect.stringContaining('sess-gone') });
    expect(events.at(-1)).toMatchObject({ status: 'succeeded' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('does not retry more than once', async () => {
    const { engine, launcher } = engineWith([replay('resume-missing', 1), replay('resume-missing', 1)]);
    const events = await collect(engine, runInput({ resumeSessionId: 'sess-gone' }));
    expect(launcher.procs).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'failed' });
  });

  it('limit → limit.hit and status limited', async () => {
    const { engine } = engineWith([replay('limit', 1)]);
    const events = await collect(engine, runInput());
    expect(types(events)).toEqual(['run.started', 'limit.hit', 'run.finished']);
    expect(events.at(-1)).toMatchObject({ status: 'limited' });
  });

  it('API error → error and failed', async () => {
    const { engine } = engineWith([replay('error', 1)]);
    const events = await collect(engine, runInput());
    expect(types(events)).toEqual(['run.started', 'error', 'run.finished']);
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('a crash without output → error with the stderr tail', async () => {
    const { engine } = engineWith([
      (p) => {
        p.stderr.write('boom\n');
        p.end(137);
      },
    ]);
    const events = await collect(engine, runInput());
    expect(events.at(-1)).toMatchObject({ status: 'failed' });
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      message: expect.stringContaining('boom'),
    });
  });

  it('spawn failure (computer cannot start) → error and failed, run files removed', async () => {
    const { engine, launcher } = engineWith([]);
    const events = await collect(engine, runInput());
    expect(types(events)).toEqual(['run.started', 'error', 'run.finished']);
    expect(events[1]).toMatchObject({ message: 'Could not run Claude Code: container is not running' });
    expect(launcher.files.size).toBe(0);
  });

  it('cancel: SIGINT, then the CLI exits; the group is reaped with SIGKILL; run.finished cancelled', async () => {
    const ac = new AbortController();
    const { engine, launcher } = engineWith([
      (p) => {
        p.write(lines('text').slice(0, 3)); // init + first stream events, then "keeps working"
        p.onSignal = (sig) => {
          if (sig === 'INT') setImmediate(() => p.end(130));
        };
      },
    ]);
    const events: EngineEvent[] = [];
    for await (const e of engine.run(runInput(), ac.signal)) {
      events.push(e);
      if (e.type === 'run.started') setTimeout(() => ac.abort(), 20);
    }
    const p = launcher.procs[0]!;
    expect(p.signals).toEqual(['INT', 'KILL']);
    expect(p.disposed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'cancelled' });
    expect(events.filter((e) => e.type === 'run.finished')).toHaveLength(1);
    expect(launcher.files.size).toBe(0);
  });

  it('cancel: a CLI that ignores SIGINT gets SIGKILL after the grace period', async () => {
    const ac = new AbortController();
    const { engine, launcher } = engineWith(
      [
        (p) => {
          p.write(lines('text').slice(0, 2));
          p.onSignal = (sig) => {
            if (sig === 'KILL') setImmediate(() => p.end(137));
          };
        },
      ],
      { killGraceMs: 40 },
    );
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 20);
    const events = await collect(engine, runInput(), ac.signal);
    expect(launcher.procs[0]!.signals.slice(0, 2)).toEqual(['INT', 'KILL']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'cancelled' });
  });

  it('cancel: a process whose stream never closes is abandoned after SIGKILL + close grace', async () => {
    const ac = new AbortController();
    const { engine, launcher } = engineWith([(p) => p.write(lines('text').slice(0, 1))], { killGraceMs: 20 });
    setTimeout(() => ac.abort(), 10);
    const events = await collect(engine, runInput(), ac.signal);
    expect(launcher.procs[0]!.signals).toContain('KILL');
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'cancelled' });
  });

  it('already-aborted signal: no process is started', async () => {
    const ac = new AbortController();
    ac.abort();
    const { engine, launcher } = engineWith([replay('text')]);
    const events = await collect(engine, runInput(), ac.signal);
    expect(types(events)).toEqual(['run.started', 'run.finished']);
    expect(events.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(launcher.procs).toHaveLength(0);
  });

  it('a consumer that stops iterating early still reaps the process group', async () => {
    const { engine, launcher } = engineWith([(p) => p.write(lines('text').slice(0, 5))]);
    for await (const e of engine.run(runInput(), new AbortController().signal)) {
      if (e.type === 'text.delta') break;
    }
    expect(launcher.procs[0]!.signals).toEqual(['KILL']);
    expect(launcher.procs[0]!.disposed).toBe(true);
    expect(launcher.files.size).toBe(0);
  });
});
