// SMOKE=1 pnpm smoke:claude — ONE real Claude Code turn through the F08 adapter, in a throwaway bot computer
// (temp DB + temp bot home, container labelled agenta=1 and removed afterwards). Costs a little subscription usage.
// The raw stream-json transcript is saved to data/smoke/claude-F08.jsonl (git-ignored) for sanitized fixtures.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, createRepos, openDb } from '@agenta/db';
import type { EngineEvent } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../apps/runner/src/bus';
import { createDockerApi } from '../../apps/runner/src/containers/docker';
import { botHomeDir } from '../../apps/runner/src/containers/home';
import { ContainerManager } from '../../apps/runner/src/containers/manager';
import { proxyEnv } from '../../apps/runner/src/containers/spec';
import { ClaudeEngine } from '../../apps/runner/src/engines/claude';
import { CLAUDE_TOKEN_VAR } from '../../apps/runner/src/engines/claude-token';
import { ContainerLauncher } from '../../apps/runner/src/engines/process';
import { envFileSource } from '../../apps/runner/src/engines/secrets';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const enabled = process.env.SMOKE === '1';
const token = envFileSource({ shellEnv: {}, envFile: join(repo, '.env.local') }).get(CLAUDE_TOKEN_VAR);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const PROMPT = 'Create hello.txt containing hi, then reply DONE';

describe.runIf(enabled && Boolean(token))('smoke: Claude Code adapter (real engine)', () => {
  it('creates hello.txt and streams persisted events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenta-smoke-claude-'));
    const db = openDb(join(dir, 'smoke.db'));
    const repos = createRepos(db);
    const botsDir = join(dir, 'bots');
    const manager = new ContainerManager({
      docker: createDockerApi(),
      repos,
      bus: new EventBus(),
      log: silent,
      botsDir,
      sharedDir: join(dir, 'shared'),
      containerEnv: proxyEnv(process.env),
      healthTimeoutMs: 90_000,
    });
    const bot = repos.bots.create({ name: `F08 Smoke ${Date.now().toString(36)}`, engine: 'claude' });
    const thread = repos.threads.create({ kind: 'dm', title: 'F08 smoke', memberBotIds: [bot.id] });
    const run = repos.runs.create({
      botId: bot.id,
      threadId: thread.id,
      trigger: 'user',
      engine: 'claude',
      prompt: PROMPT,
    });
    const raw: unknown[] = [];
    const engine = new ClaudeEngine({
      launcher: new ContainerLauncher((id, o) => manager.exec(id, o), botsDir),
      env: () => ({ [CLAUDE_TOKEN_VAR]: token! }),
      log: silent,
      tap: (m) => raw.push(m),
    });
    const events: EngineEvent[] = [];
    let hello: string | null;
    let persisted: number;
    try {
      for await (const e of engine.run(
        {
          bot,
          threadId: thread.id,
          prompt: PROMPT,
          systemPromptAppend: 'You are F08 Smoke, a bot on the Agent A platform.',
          mcpConfigPath: '/home/bot/.agenta/mcp.json',
          cwd: '/home/bot/work',
        },
        new AbortController().signal,
      )) {
        events.push(e);
        repos.runs.appendEvent(run.id, e.type, e);
      }
    } finally {
      mkdirSync(join(repo, 'data', 'smoke'), { recursive: true });
      writeFileSync(
        join(repo, 'data', 'smoke', 'claude-F08.jsonl'),
        raw.map((m) => JSON.stringify(m)).join('\n') + '\n',
      );
      writeFileSync(join(repo, 'data', 'smoke', 'claude-F08.events.json'), JSON.stringify(events, null, 2));
      const home = botHomeDir(botsDir, bot.id);
      hello = existsSync(join(home, 'work', 'hello.txt'))
        ? readFileSync(join(home, 'work', 'hello.txt'), 'utf8')
        : null;
      persisted = repos.runs.listEvents(run.id).length;
      await manager.stop(bot.id).catch(() => undefined);
      const c = repos.bots.get(bot.id)?.containerId;
      if (c) await createDockerApi().remove(c);
      manager.stopLoops();
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }

    expect(events[0]).toMatchObject({ type: 'run.started', engine: 'claude' });
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' });
    expect(events.some((e) => e.type === 'tool.call')).toBe(true);
    expect(
      events
        .filter((e) => e.type === 'text.final')
        .map((e) => e.text)
        .join(' '),
    ).toContain('DONE');
    expect(hello?.trim()).toBe('hi');
    expect(persisted).toBe(events.length);
  });
});

describe.skipIf(enabled)('smoke: Claude Code adapter', () => {
  it('is skipped without SMOKE=1', () => expect(enabled).toBe(false));
});
