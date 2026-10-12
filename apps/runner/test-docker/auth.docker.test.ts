// @docker — engine credential plumbing against a real bot container (pnpm test:docker). Fake credentials only:
// the CLIs' status commands are offline, so nothing reaches Anthropic or OpenAI.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus';
import { createDockerApi } from '../src/containers/docker';
import { ContainerManager } from '../src/containers/manager';
import { proxyEnv } from '../src/containers/spec';
import { EngineAuth } from '../src/engines/auth';
import { writePrivate } from '../src/engines/codex-auth';
import { envFileSource } from '../src/engines/secrets';
import { FAKE_CLAUDE_TOKEN, fakeCodexAuth, tokenLine } from '../test/engines/helpers';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe('@docker engine auth plumbing', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let manager: ContainerManager;
  let auth: EngineAuth;
  let botId: string;

  async function run(script: string, env?: Record<string, string>) {
    const h = await manager.exec(botId, { cmd: ['bash', '-lc', script], env });
    let out = '';
    h.stdout.on('data', (c: Buffer) => (out += c.toString()));
    h.stderr.on('data', (c: Buffer) => (out += c.toString()));
    const code = await h.wait();
    return { code, out };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-auth-docker-'));
    db = openDb(join(dir, 'test.db'));
    repos = createRepos(db);
    const envFile = join(dir, '.env.local');
    writeFileSync(envFile, tokenLine(FAKE_CLAUDE_TOKEN));
    writePrivate(join(dir, 'secrets', 'codex', 'auth.json'), fakeCodexAuth({ plan: 'plus' }));
    manager = new ContainerManager({
      docker: createDockerApi(),
      repos,
      bus: new EventBus(),
      log: silent,
      botsDir: join(dir, 'bots'),
      sharedDir: join(dir, 'shared'),
      containerEnv: proxyEnv(process.env),
      healthTimeoutMs: 90_000,
      prepareHome: (id, home) => auth.prepareHome(id, home),
    });
    auth = new EngineAuth({
      secrets: envFileSource({ shellEnv: {}, envFile }),
      secretsDir: join(dir, 'secrets'),
      botsDir: join(dir, 'bots'),
      repos,
      exec: (id, opts) => manager.exec(id, opts),
      log: silent,
    });
    botId = repos.bots.create({ name: `F06 Auth ${Date.now().toString(36)}`, engine: 'claude' }).id;
  });

  afterAll(async () => {
    const id = repos.bots.get(botId)?.containerId;
    if (id) await createDockerApi().remove(id);
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('token only in exec env; Codex login copied in with mode 600; CLIs accept both', async () => {
    const status = await manager.start(botId);

    // docker inspect: the container's own Env never holds the token.
    const env = JSON.parse(
      execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}', status.containerId!], {
        encoding: 'utf8',
      }),
    ) as string[];
    expect(env.join('\n')).not.toContain(FAKE_CLAUDE_TOKEN);

    // A plain exec (e.g. a terminal) doesn't see it; an engine exec does.
    expect((await run('printenv CLAUDE_CODE_OAUTH_TOKEN || echo none')).out.trim()).toBe('none');
    const claude = await run('claude auth status --json', auth.execEnv('claude'));
    expect(claude.code).toBe(0);
    expect(JSON.parse(claude.out)).toMatchObject({ loggedIn: true, authMethod: 'oauth_token' });

    // Nothing in the home contains the token afterwards.
    const grep = await run(`grep -rlF '${FAKE_CLAUDE_TOKEN}' /home/bot /tmp 2>/dev/null || echo clean`);
    expect(grep.out.trim()).toBe('clean');

    // Codex: the shared login was copied into ~/.codex before start, mode 600, and Codex accepts it.
    expect((await run('stat -c %a ~/.codex/auth.json')).out.trim()).toBe('600');
    const codex = await run('codex login status');
    expect(codex).toMatchObject({ code: 0 });
    expect(codex.out).toContain('Logged in using ChatGPT');

    // Status API path, with the CLI verification inside the running computer.
    const [c, x] = await auth.statuses({ verify: true });
    expect(c).toMatchObject({ state: 'configured', mode: 'token', cli: { checked: true, ok: true } });
    expect(x).toMatchObject({ state: 'configured', mode: 'shared-file', cli: { checked: true, ok: true } });

    // A token refresh inside the container is copied back after a run.
    await run(`cat > ~/.codex/auth.json <<'J'\n${fakeCodexAuth({ plan: 'plus', version: 2 })}\nJ`);
    await auth.afterCodexRun(botId);
    expect(readFileSync(join(dir, 'secrets', 'codex', 'auth.json'), 'utf8').trim()).toBe(
      fakeCodexAuth({ plan: 'plus', version: 2 }),
    );
  });
});
