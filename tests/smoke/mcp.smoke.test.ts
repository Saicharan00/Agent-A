// SMOKE=1 pnpm smoke:mcp (F35). 1) The gateway connects to the Context7 docs preset and lists its tools (no engine).
// 2) ONE real Claude Code turn in a throwaway bot computer that has Context7 granted through the gateway: it must call
// a context7__ tool via the Platform MCP endpoint and cite a source. Costs a little subscription usage; skipped while
// mcp.context7.com is not allowed in the sandbox network policy. Events go to data/smoke/mcp-F35.events.json.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, createRepos, openDb } from '@agenta/db';
import { type EngineEvent, MCP_PRESETS } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { ApprovalService } from '../../apps/runner/src/approvals/service';
import { ensureMcpToken } from '../../apps/runner/src/bots/mcp-token';
import { EventBus } from '../../apps/runner/src/bus';
import { createDockerApi } from '../../apps/runner/src/containers/docker';
import { botHomeDir } from '../../apps/runner/src/containers/home';
import { ContainerManager } from '../../apps/runner/src/containers/manager';
import { proxyEnv } from '../../apps/runner/src/containers/spec';
import { ClaudeEngine } from '../../apps/runner/src/engines/claude';
import { CLAUDE_TOKEN_VAR } from '../../apps/runner/src/engines/claude-token';
import { ContainerLauncher } from '../../apps/runner/src/engines/process';
import { renderInstructionFiles, writeInstructionFiles } from '../../apps/runner/src/engines/prompt';
import { envFileSource } from '../../apps/runner/src/engines/secrets';
import { GatewayService } from '../../apps/runner/src/gateway/service';
import { PlatformMcpServer } from '../../apps/runner/src/mcp/server';
import { PlatformTools } from '../../apps/runner/src/mcp/tools';
import { writeMcpConfig } from '../../apps/runner/src/runs/prepare';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const enabled = process.env.SMOKE === '1';
const secrets = envFileSource({ shellEnv: {}, envFile: join(repo, '.env.local') });
const token = secrets.get(CLAUDE_TOKEN_VAR);
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const context7 = MCP_PRESETS.find((p) => p.id === 'context7')!.server;
const PROMPT =
  'Using your Context7 docs tools, find how to define an object schema in the latest Zod. Answer in two sentences ' +
  'and cite your source.';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agenta-smoke-mcp-'));
  const db = openDb(join(dir, 'smoke.db'));
  const repos = createRepos(db);
  const gateway = new GatewayService({
    repos,
    secrets,
    approvals: new ApprovalService({ repos }),
    log: silent,
  });
  const server = gateway.create(context7);
  return { dir, db, repos, gateway, server };
}

describe.runIf(enabled)('smoke: MCP gateway & web research', () => {
  it('connects to the Context7 docs preset and lists its tools', async () => {
    const { dir, db, gateway, server } = setup();
    try {
      const tested = await gateway.test(server.id);
      expect(tested.lastError, tested.lastError ?? '').toBeNull();
      expect(tested.tools.length).toBeGreaterThan(0);
    } finally {
      await gateway.close();
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(token))('a real Claude bot answers with a source using the docs tools', async (ctx) => {
    const { dir, db, repos, gateway, server } = setup();
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
    const tools = new PlatformTools({
      repos,
      threads: {
        postAsBot: () => {
          throw new Error('not in this smoke');
        },
        askBot: () => {
          throw new Error('not in this smoke');
        },
      },
      log: silent,
    });
    const mcp = new PlatformMcpServer({ repos, tools, gateway, log: silent });
    const events: EngineEvent[] = [];
    const bot = repos.bots.create({ name: `F35 Smoke ${Date.now().toString(36)}`, engine: 'claude' });
    try {
      if ((await gateway.test(server.id)).lastError) return ctx.skip(); // network not allowed yet (HUMAN_TODO)
      gateway.setAccess(bot.id, [{ serverId: server.id }]);
      const thread = repos.threads.create({ kind: 'dm', title: 'F35 smoke', memberBotIds: [bot.id] });
      await manager.ensureRunning(bot.id);
      const port = await mcp.listen(await manager.networkGateway(), 0);
      const home = botHomeDir(botsDir, bot.id);
      ensureMcpToken(repos, botsDir, bot.id);
      writeMcpConfig(home, `http://host.docker.internal:${port}/mcp`);
      writeInstructionFiles(home, renderInstructionFiles(bot, [], [], [], gateway.instructionTools(bot.id)));
      const engine = new ClaudeEngine({
        launcher: new ContainerLauncher((id, o) => manager.exec(id, o), botsDir),
        env: () => ({ [CLAUDE_TOKEN_VAR]: token! }),
        log: silent,
      });
      for await (const e of engine.run(
        {
          bot,
          threadId: thread.id,
          prompt: PROMPT,
          systemPromptAppend: '',
          mcpConfigPath: '/home/bot/.agenta/mcp.json',
          cwd: '/home/bot/work',
        },
        new AbortController().signal,
      ))
        events.push(e);
    } finally {
      mkdirSync(join(repo, 'data', 'smoke'), { recursive: true });
      writeFileSync(join(repo, 'data', 'smoke', 'mcp-F35.events.json'), JSON.stringify(events, null, 2));
      await mcp.close();
      await gateway.close();
      await manager.stop(bot.id).catch(() => undefined);
      const c = repos.bots.get(bot.id)?.containerId;
      if (c) await createDockerApi().remove(c);
      manager.stopLoops();
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', status: 'succeeded' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool.call', name: expect.stringMatching(/^mcp__agenta__context7__/) }),
    );
    const text = events.flatMap((e) => (e.type === 'text.final' ? [e.text] : [])).join(' ');
    expect(text).toMatch(/https?:\/\/|context7|source/i);
  });
});

describe.skipIf(enabled)('smoke: MCP gateway & web research', () => {
  it('is skipped without SMOKE=1', () => expect(enabled).toBe(false));
});
