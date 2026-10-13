// SMOKE=1 pnpm smoke:browser — ONE real Claude Code turn (F16) that drives the Playwright MCP browser, headed on the
// bot's desktop, in a throwaway bot computer (temp DB + temp bot home, container labelled agenta=1 and removed
// afterwards). Costs a little subscription usage. Events are saved to data/smoke/browser-F16.events.json.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { writeMcpConfig } from '../../apps/runner/src/runs/prepare';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const enabled = process.env.SMOKE === '1';
const token = envFileSource({ shellEnv: {}, envFile: join(repo, '.env.local') }).get(CLAUDE_TOKEN_VAR);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const PROMPT = 'Open example.com in the browser and tell me the page title';

describe.runIf(enabled && Boolean(token))('smoke: Playwright MCP browser (real engine)', () => {
  it('navigates with the headed browser and reports the title', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agenta-smoke-browser-'));
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
    const bot = repos.bots.create({ name: `F16 Smoke ${Date.now().toString(36)}`, engine: 'claude' });
    const thread = repos.threads.create({ kind: 'dm', title: 'F16 smoke', memberBotIds: [bot.id] });
    const engine = new ClaudeEngine({
      launcher: new ContainerLauncher((id, o) => manager.exec(id, o), botsDir),
      env: () => ({ [CLAUDE_TOKEN_VAR]: token! }),
      log: silent,
    });
    const events: EngineEvent[] = [];
    let profile: boolean;
    try {
      await manager.ensureRunning(bot.id);
      const home = botHomeDir(botsDir, bot.id);
      writeMcpConfig(home);
      for await (const e of engine.run(
        {
          bot,
          threadId: thread.id,
          prompt: PROMPT,
          systemPromptAppend: 'Use the Playwright MCP browser for web tasks; the owner can watch.',
          mcpConfigPath: '/home/bot/.agenta/mcp.json',
          cwd: '/home/bot/work',
        },
        new AbortController().signal,
      )) {
        events.push(e);
      }
      profile = existsSync(join(home, '.browser-profile', 'Default'));
    } finally {
      mkdirSync(join(repo, 'data', 'smoke'), { recursive: true });
      writeFileSync(join(repo, 'data', 'smoke', 'browser-F16.events.json'), JSON.stringify(events, null, 2));
      await manager.stop(bot.id).catch(() => undefined);
      const c = repos.bots.get(bot.id)?.containerId;
      if (c) await createDockerApi().remove(c);
      manager.stopLoops();
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }

    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.call',
        name: 'mcp__playwright__browser_navigate',
        input: expect.objectContaining({ url: expect.stringContaining('example.com') }),
      }),
    );
    const text = events.flatMap((e) => (e.type === 'text.final' ? [e.text] : [])).join(' ');
    expect(text).toContain('Example Domain');
    expect(profile).toBe(true); // the persistent per-bot profile was used
  });
});

describe.skipIf(enabled)('smoke: Playwright MCP browser', () => {
  it('is skipped without SMOKE=1', () => expect(enabled).toBe(false));
});
