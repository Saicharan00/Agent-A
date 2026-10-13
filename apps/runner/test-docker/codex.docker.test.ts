// @docker — Codex home preparation against a real bot computer (pnpm test:docker). Offline: `codex debug
// prompt-input` renders the model-visible prompt without calling OpenAI, so no usage is spent.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus';
import { createDockerApi } from '../src/containers/docker';
import { botHomeDir } from '../src/containers/home';
import { ContainerManager } from '../src/containers/manager';
import { proxyEnv } from '../src/containers/spec';
import { buildCodexArgs, prepareCodexHome } from '../src/engines/codex';
import { ContainerLauncher } from '../src/engines/process';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function run(manager: ContainerManager, botId: string, cmd: string[]) {
  const h = await manager.exec(botId, { cmd, workdir: '/home/bot/work' });
  let out = '';
  h.stdout.on('data', (c: Buffer) => (out += c.toString()));
  h.stderr.on('data', (c: Buffer) => (out += c.toString()));
  const code = await h.wait();
  return { code, out };
}

describe('@docker Codex home preparation', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let manager: ContainerManager;
  let botId: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-docker-codex-'));
    db = openDb(join(dir, 'test.db'));
    repos = createRepos(db);
    manager = new ContainerManager({
      docker: createDockerApi(),
      repos,
      bus: new EventBus(),
      log: silent,
      botsDir: join(dir, 'bots'),
      sharedDir: join(dir, 'shared'),
      containerEnv: proxyEnv(process.env),
      healthTimeoutMs: 90_000,
    });
    botId = repos.bots.create({ name: `F09 Codex ${Date.now().toString(36)}`, engine: 'codex' }).id;
  });

  afterAll(async () => {
    const id = repos.bots.get(botId)?.containerId;
    await manager.stop(botId).catch(() => undefined);
    if (id) await createDockerApi().remove(id);
    manager.stopLoops();
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('instructions, developer text and MCP servers reach Codex', async () => {
    await manager.start(botId);
    const launcher = new ContainerLauncher((id, o) => manager.exec(id, o), join(dir, 'bots'));
    const home = botHomeDir(join(dir, 'bots'), botId);
    writeFileSync(join(home, 'AGENTS.md'), '# Coder\nMARKER-AGENTS: always answer in English.\n');
    launcher.writeHomeFile(
      botId,
      '.agenta/mcp.json',
      JSON.stringify({ mcpServers: { agenta: { type: 'http', url: 'http://172.19.0.1:3002/mcp' } } }),
    );
    prepareCodexHome(launcher, { bot: { id: botId } as never, mcpConfigPath: '/home/bot/.agenta/mcp.json' });

    // The same `-c developer_instructions=…` the adapter passes.
    const args = buildCodexArgs({ resume: false, developerInstructions: 'MARKER-DEV You are "Coder".' });
    const dev = args[args.indexOf('-c') + 1]!;
    const prompt = await run(manager, botId, ['codex', 'debug', 'prompt-input', '-c', dev, 'MARKER-PROMPT']);
    expect(prompt.code).toBe(0);
    expect(prompt.out).toContain('MARKER-AGENTS: always answer in English.');
    expect(prompt.out).toContain('MARKER-DEV You are \\"Coder\\".');
    expect(prompt.out).toContain('MARKER-PROMPT');

    const mcp = await run(manager, botId, ['codex', 'mcp', 'list']);
    expect(mcp.code).toBe(0);
    expect(mcp.out).toMatch(/playwright\s+playwright-mcp/);
    expect(mcp.out).toMatch(/agenta\s+http:\/\/172\.19\.0\.1:3002\/mcp/);
  });
});
