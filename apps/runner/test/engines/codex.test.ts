import { readFileSync } from 'node:fs';
import { type EngineEvent, engineEventSchema } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import {
  CodexEngine,
  CodexStreamMapper,
  buildCodexArgs,
  parseMcpConfig,
  renderCodexConfig,
} from '../../src/engines/codex';
import type { EngineRunInput } from '../../src/engines/types';
import { type Behavior, FakeLauncher, collectEvents, replayText, silent } from './fake-launcher';

const NOW = new Date('2026-10-13T10:00:00.000Z');
const THREAD = '00000000-0000-7000-8000-000000000001';
const read = (file: string): string =>
  readFileSync(new URL(`../fixtures/codex/${file}`, import.meta.url), 'utf8');
const fixture = (name: string) => read(`${name}.jsonl`);
const lines = (name: string): unknown[] =>
  fixture(name)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);

function mapFixture(name: string, exitCode = 0, stderr = '') {
  const m = new CodexStreamMapper(() => NOW);
  const events = lines(name).flatMap((l) => m.map(l));
  const done = m.finish(exitCode, stderr);
  return { mapper: m, events: [...events, ...done.events], status: done.status };
}

const types = (es: EngineEvent[]) => es.map((e) => e.type);
const item = (type: 'item.started' | 'item.completed', it: Record<string, unknown>) => ({ type, item: it });

describe('CodexStreamMapper (fixtures)', () => {
  it('text: final message and usage; the thread id is the session id', () => {
    const { events, status, mapper } = mapFixture('text');
    expect(status).toBe('succeeded');
    expect(mapper.sessionId).toBe(THREAD);
    expect(events).toEqual([
      { type: 'text.final', text: 'DONE' },
      { type: 'usage', inputTokens: 28459, outputTokens: 60 },
    ]);
  });

  it('tools: command_execution → shell tool call + result between the messages', () => {
    const { events, status } = mapFixture('tools');
    expect(status).toBe('succeeded');
    expect(types(events)).toEqual(['text.final', 'tool.call', 'tool.result', 'text.final', 'usage']);
    expect(events[1]).toEqual({
      type: 'tool.call',
      callId: 'item_1',
      name: 'shell',
      input: { command: "/bin/bash -lc 'printf hi > hello.txt'" },
    });
    expect(events[2]).toEqual({ type: 'tool.result', callId: 'item_1', output: '' });
    for (const e of events) engineEventSchema.parse(e);
  });

  it('error: transient reconnects are ignored; turn.failed is one error', () => {
    const { events, status } = mapFixture('error', 1);
    expect(status).toBe('failed');
    expect(events).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('stream disconnected before completion') as string,
      },
    ]);
  });

  it('limit: one limit.hit with the reset time, status limited', () => {
    const { events, status } = mapFixture('limit', 1);
    expect(status).toBe('limited');
    expect(types(events)).toEqual(['limit.hit']);
    expect(events[0]).toMatchObject({
      type: 'limit.hit',
      engine: 'codex',
      resetsAt: '2026-10-14T09:05:00.000Z',
      raw: expect.stringContaining('usage limit') as string,
    });
  });

  it('resume-missing: detected from stderr, no error event', () => {
    const m = new CodexStreamMapper();
    const done = m.finish(1, read('resume-missing.stderr.txt'));
    expect(m.resumeMissing).toBe(true);
    expect(done).toEqual({ events: [], status: 'failed' });
  });
});

describe('CodexStreamMapper (item types)', () => {
  it('a failing command is an error result', () => {
    const m = new CodexStreamMapper();
    m.map(
      item('item.started', { id: 'c1', type: 'command_execution', command: 'false', status: 'in_progress' }),
    );
    expect(
      m.map(
        item('item.completed', {
          id: 'c1',
          type: 'command_execution',
          command: 'false',
          aggregated_output: 'nope\n',
          exit_code: 1,
          status: 'failed',
        }),
      ),
    ).toEqual([{ type: 'tool.result', callId: 'c1', output: 'nope\n', isError: true }]);
  });

  it('file_change → apply_patch call + result + one file.changed per path', () => {
    const m = new CodexStreamMapper();
    const changes = [
      { path: '/home/bot/work/a.ts', kind: 'add' },
      { path: '/home/bot/work/b.ts', kind: 'update' },
      { path: '/home/bot/work/c.ts', kind: 'delete' },
    ];
    expect(
      m.map(item('item.completed', { id: 'f1', type: 'file_change', changes, status: 'completed' })),
    ).toEqual([
      { type: 'tool.call', callId: 'f1', name: 'apply_patch', input: { changes } },
      {
        type: 'tool.result',
        callId: 'f1',
        output: 'add /home/bot/work/a.ts\nupdate /home/bot/work/b.ts\ndelete /home/bot/work/c.ts',
      },
      { type: 'file.changed', path: '/home/bot/work/a.ts', change: 'created' },
      { type: 'file.changed', path: '/home/bot/work/b.ts', change: 'modified' },
      { type: 'file.changed', path: '/home/bot/work/c.ts', change: 'deleted' },
    ]);
    // a failed patch changes nothing
    expect(
      m
        .map(item('item.completed', { id: 'f2', type: 'file_change', changes, status: 'failed' }))
        .filter((e) => e.type === 'file.changed'),
    ).toEqual([]);
  });

  it('mcp_tool_call → mcp__server__tool, text result or error', () => {
    const m = new CodexStreamMapper();
    const base = {
      id: 'm1',
      type: 'mcp_tool_call',
      server: 'agenta',
      tool: 'create_task',
      arguments: { title: 'x' },
    };
    expect(m.map(item('item.started', { ...base, status: 'in_progress' }))).toEqual([
      { type: 'tool.call', callId: 'm1', name: 'mcp__agenta__create_task', input: { title: 'x' } },
    ]);
    expect(
      m.map(
        item('item.completed', {
          ...base,
          status: 'completed',
          result: { content: [{ type: 'text', text: 'Created tsk_1' }] },
          error: null,
        }),
      ),
    ).toEqual([{ type: 'tool.result', callId: 'm1', output: 'Created tsk_1' }]);
    expect(
      m.map(item('item.completed', { ...base, id: 'm2', status: 'failed', error: { message: 'denied' } })),
    ).toEqual([
      { type: 'tool.call', callId: 'm2', name: 'mcp__agenta__create_task', input: { title: 'x' } },
      { type: 'tool.result', callId: 'm2', output: 'denied', isError: true },
    ]);
  });

  it('reasoning → thinking; web_search → web_search call; todo lists and notices ignored', () => {
    const m = new CodexStreamMapper();
    expect(m.map(item('item.completed', { id: 'r', type: 'reasoning', text: 'plan' }))).toEqual([
      { type: 'thinking', text: 'plan' },
    ]);
    expect(m.map(item('item.completed', { id: 'w', type: 'web_search', query: 'codex cli' }))).toEqual([
      { type: 'tool.call', callId: 'w', name: 'web_search', input: { query: 'codex cli' } },
      { type: 'tool.result', callId: 'w', output: '' },
    ]);
    expect(m.map({ type: 'item.updated', item: { id: 't', type: 'todo_list', items: [] } })).toEqual([]);
    expect(
      m.map(item('item.completed', { id: 'e', type: 'error', message: 'Falling back from WebSockets' })),
    ).toEqual([]);
    expect(m.map('garbage')).toEqual([]);
  });

  it('exit without turn.completed: error with the last non-transient error, failed', () => {
    const m = new CodexStreamMapper();
    m.map({ type: 'error', message: 'model "gpt-x" not found' });
    expect(m.finish(1, '')).toEqual({
      events: [
        {
          type: 'error',
          message: 'Codex exited with code 1 without finishing the turn: model "gpt-x" not found',
        },
      ],
      status: 'failed',
    });
  });

  it('a limit reported only on stderr still becomes limit.hit', () => {
    const m = new CodexStreamMapper(() => NOW);
    const done = m.finish(1, 'Error: You have hit your usage limit. Try again in 45 minutes.');
    expect(done.status).toBe('limited');
    expect(done.events[0]).toMatchObject({ type: 'limit.hit', resetsAt: '2026-10-13T10:45:00.000Z' });
  });
});

describe('buildCodexArgs', () => {
  it('new turn reads the prompt from stdin; resume puts the id after `resume`', () => {
    expect(buildCodexArgs({ resume: false })).toEqual([
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ]);
    expect(
      buildCodexArgs({
        resume: true,
        sessionId: 'th_1',
        model: 'gpt-5.5',
        developerInstructions: 'Be "nice"\nok',
      }),
    ).toEqual([
      'codex',
      'exec',
      'resume',
      'th_1',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'gpt-5.5',
      '-c',
      'developer_instructions="Be \\"nice\\"\\nok"',
      '-',
    ]);
  });
});

describe('Codex config', () => {
  it('renders Playwright plus the servers of the Claude-style MCP config', () => {
    const servers = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          agenta: {
            type: 'http',
            url: 'http://172.19.0.1:3002/mcp',
            headers: { Authorization: 'Bearer t"1' },
          },
          'my.srv': { command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } },
          broken: { type: 'stdio' },
        },
      }),
    );
    expect(renderCodexConfig(servers)).toBe(
      [
        '# Rendered by Agent A before each Codex run. Edits here are overwritten.',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        '',
        '[mcp_servers.playwright]',
        'command = "playwright-mcp"',
        'args = ["--config", "/opt/agenta/defaults/playwright-mcp.json"]',
        '',
        '[mcp_servers.agenta]',
        'url = "http://172.19.0.1:3002/mcp"',
        'http_headers = { Authorization = "Bearer t\\"1" }',
        '',
        '[mcp_servers."my.srv"]',
        'command = "npx"',
        'args = ["-y", "pkg"]',
        'env = { K = "v" }',
        '',
      ].join('\n'),
    );
  });

  it('missing or invalid MCP config → no extra servers', () => {
    expect(parseMcpConfig(undefined)).toEqual({});
    expect(parseMcpConfig('{nope')).toEqual({});
    expect(parseMcpConfig('[]')).toEqual({});
  });
});

// ---------- adapter ----------

const runInput = (over: Partial<EngineRunInput> = {}): EngineRunInput => ({
  bot: { id: 'bot_1', name: 'Coder', slug: 'coder', role: '', engine: 'codex', model: null },
  threadId: 'thr_1',
  prompt: 'Create hello.txt containing hi, then reply DONE',
  systemPromptAppend: 'You are Coder.',
  mcpConfigPath: '/home/bot/.agenta/mcp.json',
  cwd: '/home/bot/work',
  ...over,
});

function engineWith(behaviors: Behavior[], hooks: { before?: () => Promise<void> } = {}) {
  const launcher = new FakeLauncher(behaviors);
  const calls: string[] = [];
  const engine = new CodexEngine({
    launcher,
    env: () => ({}),
    log: silent,
    killGraceMs: 30,
    closeGraceMs: 30,
    now: () => NOW,
    beforeRun: async (botId) => {
      calls.push(`before:${botId}`);
      await hooks.before?.();
    },
    afterRun: async (botId) => {
      calls.push(`after:${botId}`);
    },
  });
  return { engine, launcher, calls };
}

const replay = (name: string, code = 0, stderr = ''): Behavior => replayText(fixture(name), code, stderr);

describe('CodexEngine', () => {
  it('syncs auth, renders config + AGENTS.md, runs with stdin prompt, copies auth back', async () => {
    let filesDuringRun = new Map<string, string>();
    const { engine, launcher, calls } = engineWith([
      (p) => {
        filesDuringRun = new Map(launcher.files);
        calls.push('spawn');
        replay('tools')(p);
      },
    ]);
    launcher.homeFiles.set('/home/bot/AGENTS.md', '# Coder\nInstructions');
    launcher.homeFiles.set(
      '/home/bot/.agenta/mcp.json',
      JSON.stringify({ mcpServers: { agenta: { url: 'http://h/mcp' } } }),
    );
    const events = await collectEvents(engine, runInput());
    expect(calls).toEqual(['before:bot_1', 'spawn', 'after:bot_1']);
    expect(events[0]).toEqual({ type: 'run.started', engine: 'codex' });
    expect(events.at(-1)).toEqual({ type: 'run.finished', status: 'succeeded', sessionId: THREAD });
    const spec = launcher.procs[0]!.spec;
    expect(spec.cmd.slice(0, 2)).toEqual(['codex', 'exec']);
    expect(spec.cmd).toContain('developer_instructions="You are Coder."');
    expect(spec.cmd.join(' ')).not.toContain('hello.txt');
    expect(spec.stdinFile).toMatch(/^\/home\/bot\/\.agenta\/runs\/[0-9a-f-]+\/prompt\.md$/);
    expect(spec.env).toEqual({ DISPLAY: ':99' });
    expect(filesDuringRun.get('.codex/AGENTS.md')).toBe('# Coder\nInstructions');
    expect(filesDuringRun.get('.codex/config.toml')).toContain('[mcp_servers.agenta]\nurl = "http://h/mcp"');
    expect([...filesDuringRun.keys()].some((k) => k.endsWith('system.md'))).toBe(false);
    // per-run files removed, the Codex home files stay
    expect([...launcher.files.keys()].sort()).toEqual(['.codex/AGENTS.md', '.codex/config.toml']);
  });

  it('resume: `exec resume <id>`; a vanished thread retries once as a new one with a system note', async () => {
    const { engine, launcher, calls } = engineWith([
      replayText('', 1, read('resume-missing.stderr.txt')),
      replay('text'),
    ]);
    const events = await collectEvents(engine, runInput({ resumeSessionId: 'th_gone', model: 'gpt-5.5' }));
    expect(launcher.procs[0]!.spec.cmd.slice(0, 4)).toEqual(['codex', 'exec', 'resume', 'th_gone']);
    expect(launcher.procs[1]!.spec.cmd).not.toContain('resume');
    expect(launcher.procs[1]!.spec.cmd).toEqual(expect.arrayContaining(['-m', 'gpt-5.5']));
    expect(types(events)).toEqual(['run.started', 'system', 'text.final', 'usage', 'run.finished']);
    expect(events[0]).toEqual({ type: 'run.started', engine: 'codex', sessionId: 'th_gone' });
    expect(events.at(-1)).toEqual({ type: 'run.finished', status: 'succeeded', sessionId: THREAD });
    expect(calls).toEqual(['before:bot_1', 'after:bot_1']);
  });

  it('limit → limited', async () => {
    const { engine } = engineWith([replay('limit', 1)]);
    const events = await collectEvents(engine, runInput());
    expect(types(events)).toEqual(['run.started', 'limit.hit', 'run.finished']);
    expect(events.at(-1)).toMatchObject({ status: 'limited', sessionId: THREAD });
  });

  it('cancel: SIGINT, group reaped, auth still copied back, run.finished cancelled', async () => {
    const ac = new AbortController();
    const { engine, launcher, calls } = engineWith([
      (p) => {
        p.write(lines('tools').slice(0, 2));
        p.onSignal = (sig) => {
          if (sig === 'INT') setImmediate(() => p.end(130));
        };
        setTimeout(() => ac.abort(), 10);
      },
    ]);
    const events = await collectEvents(engine, runInput(), ac.signal);
    expect(launcher.procs[0]!.signals).toEqual(['INT', 'KILL']);
    expect(launcher.procs[0]!.disposed).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'run.finished', status: 'cancelled', sessionId: THREAD });
    expect(calls).toEqual(['before:bot_1', 'after:bot_1']);
  });

  it('a failing auth sync fails the run before Codex starts (no copy-back)', async () => {
    const { engine, launcher, calls } = engineWith([replay('text')], {
      before: () => Promise.reject(new Error('auth.json is locked')),
    });
    const events = await collectEvents(engine, runInput());
    expect(launcher.procs).toHaveLength(0);
    expect(events[1]).toEqual({ type: 'error', message: 'Could not run Codex: auth.json is locked' });
    expect(events.at(-1)).toEqual({ type: 'run.finished', status: 'failed' });
    expect(calls).toEqual(['before:bot_1']);
  });
});
