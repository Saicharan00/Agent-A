import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import { engineSettingsResponseSchema } from '@agenta/shared';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/bus';
import { loadConfig } from '../../src/config';
import { ContainerManager } from '../../src/containers/manager';
import { EngineAuth, claudeTokenProblem } from '../../src/engines/auth';
import { writePrivate } from '../../src/engines/codex-auth';
import { envFileSource } from '../../src/engines/secrets';
import { LOG_REDACT, buildServer } from '../../src/server';
import { FakeDocker } from '../containers/fake-docker';
import { FAKE_ANTHROPIC_API_KEY, FAKE_CLAUDE_TOKEN, fakeCodexAuth, tokenLine } from './helpers';

/** pino logger (with the runner's redaction) writing into `lines`. */
function captureLog(lines: string[]) {
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return pino({ level: 'debug', redact: LOG_REDACT }, stream);
}

describe('EngineAuth', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let docker: FakeDocker;
  let logLines: string[];
  let envFile: string;
  let secretsDir: string;
  let botsDir: string;
  let manager: ContainerManager;
  let auth: EngineAuth;
  let botId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-auth-'));
    db = openDb(join(dir, 'test.db'));
    repos = createRepos(db);
    docker = new FakeDocker();
    logLines = [];
    const log = captureLog(logLines);
    envFile = join(dir, '.env.local');
    secretsDir = join(dir, 'secrets');
    botsDir = join(dir, 'bots');
    manager = new ContainerManager({
      docker,
      repos,
      bus: new EventBus(),
      log: log.child({ module: 'containers' }),
      botsDir,
      sharedDir: join(dir, 'shared'),
      containerEnv: ['HTTPS_PROXY=http://proxy:3128'],
      healthPollMs: 1,
      prepareHome: (id, home) => auth.prepareHome(id, home),
    });
    auth = new EngineAuth({
      secrets: envFileSource({ shellEnv: {}, envFile }),
      secretsDir,
      botsDir,
      repos,
      exec: (id, opts) => manager.exec(id, opts),
      log: log.child({ module: 'engine-auth' }),
    });
    botId = repos.bots.create({ name: 'Builder', engine: 'claude' }).id;
  });

  afterEach(() => {
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  const home = (id = botId) => join(botsDir, id, 'home');
  const setToken = (t: string) => writeFileSync(envFile, tokenLine(t));

  it('reports both engines missing with fix steps when nothing is configured', async () => {
    const [claude, codex] = await auth.statuses();
    expect(claude).toMatchObject({
      engine: 'claude',
      state: 'missing',
      mode: 'none',
      cli: { checked: false },
    });
    expect(codex).toMatchObject({ engine: 'codex', state: 'missing', mode: 'none' });
    expect(claude!.fix.join(' ')).toContain('pnpm auth:claude');
    expect(codex!.fix.join(' ')).toContain('pnpm auth:codex');
  });

  it('Claude: token from .env.local → configured; API keys and junk → invalid', async () => {
    setToken(FAKE_CLAUDE_TOKEN);
    expect(await auth.status('claude')).toMatchObject({ state: 'configured', mode: 'token', fix: [] });
    setToken(FAKE_ANTHROPIC_API_KEY);
    expect(await auth.status('claude')).toMatchObject({ state: 'invalid', mode: 'token' });
    expect(auth.execEnv('claude')).toEqual({});
    expect(claudeTokenProblem('hello')).toMatch(/does not look like/);
    expect(claudeTokenProblem('sk-ant-oat01 x')).toMatch(/spaces/);
  });

  it('Claude: a per-bot terminal login counts as the fallback mode', async () => {
    mkdirSync(join(home(), '.claude'), { recursive: true });
    writeFileSync(join(home(), '.claude', '.credentials.json'), '{}');
    expect(await auth.status('claude')).toMatchObject({
      state: 'configured',
      mode: 'per-bot',
      perBotLogins: ['Builder'],
    });
  });

  it('Codex: shared auth.json → configured with plan, tightened to 600; broken file → invalid', async () => {
    const shared = join(secretsDir, 'codex', 'auth.json');
    writePrivate(shared, fakeCodexAuth({ plan: 'plus' }));
    chmodSync(shared, 0o644);
    const s = await auth.status('codex');
    expect(s).toMatchObject({ state: 'configured', mode: 'shared-file' });
    expect(s.detail).toContain('plus plan');
    expect(statSync(shared).mode & 0o777).toBe(0o600);
    writeFileSync(shared, '{"tokens":{}}');
    expect(await auth.status('codex')).toMatchObject({ state: 'invalid', mode: 'shared-file' });
  });

  it('Codex: a per-bot login is detected when there is no shared file', async () => {
    writePrivate(join(home(), '.codex', 'auth.json'), fakeCodexAuth());
    expect(await auth.status('codex')).toMatchObject({
      state: 'configured',
      mode: 'per-bot',
      perBotLogins: ['Builder'],
    });
  });

  it('injects the Claude token into engine execs only: not the container env, not the logs', async () => {
    setToken(FAKE_CLAUDE_TOKEN);
    writePrivate(join(secretsDir, 'codex', 'auth.json'), fakeCodexAuth());
    await manager.start(botId);

    // Container-level env (what `docker inspect` shows) has no credentials.
    const spec = [...docker.containers.values()][0]!.spec;
    expect(spec.env.join('\n')).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(spec.env.some((e) => e.startsWith('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(false);

    // Codex login copied into the bot's home before start; a copy of the shared login isn't a per-bot login.
    expect(readFileSync(join(home(), '.codex', 'auth.json'), 'utf8')).toBe(fakeCodexAuth());
    expect((await auth.status('codex')).perBotLogins).toEqual([]);
    writePrivate(join(home(), '.codex', 'auth.json'), fakeCodexAuth({ account: 'other' }));
    expect((await auth.status('codex')).perBotLogins).toEqual(['Builder']);

    // Engine execs get the token; Codex and mock execs don't.
    expect(auth.execEnv('codex')).toEqual({});
    expect(auth.execEnv('mock')).toEqual({});
    const h = await manager.exec(botId, { cmd: ['claude', '--version'], env: auth.execEnv('claude') });
    await h.wait();
    expect(docker.execs.at(-1)!.opts.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_TOKEN });

    // Even an accidental log of the env is redacted.
    const log = captureLog(logLines);
    log.info({ env: auth.execEnv('claude') }, 'oops');
    log.info({ exec: { env: auth.execEnv('claude') } }, 'oops nested');
    await auth.statuses({ verify: true });
    const all = logLines.join('\n');
    expect(all).toContain('oops');
    expect(all).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(auth.redact(`x ${FAKE_CLAUDE_TOKEN} y`)).not.toContain(FAKE_CLAUDE_TOKEN);
  });

  it('verify runs the CLI status commands (no prompt) inside a running computer', async () => {
    setToken(FAKE_CLAUDE_TOKEN);
    expect((await auth.status('claude', { verify: true })).cli).toMatchObject({
      checked: false,
      reason: expect.stringMatching(/Start any bot computer/),
    });
    await manager.start(botId);
    docker.execResult = (opts) =>
      opts.cmd[0] === 'claude'
        ? { stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }), code: 0 }
        : { stdout: 'Not logged in\n', code: 1 };
    const [claude, codex] = await auth.statuses({ verify: true });
    expect(claude!.cli).toMatchObject({ checked: true, ok: true, botId });
    expect(codex!.cli).toMatchObject({ checked: true, ok: false, output: 'Not logged in' });
    const cmds = docker.execs.map((e) => e.opts.cmd.join(' '));
    expect(cmds).toEqual(['claude auth status --json', 'codex login status']);
    expect(docker.execs[0]!.opts.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_CLAUDE_TOKEN });
    expect(docker.execs[1]!.opts.env).toEqual({});
  });

  it('afterCodexRun copies a refreshed token back to data/secrets', async () => {
    const shared = join(secretsDir, 'codex', 'auth.json');
    writePrivate(shared, fakeCodexAuth({ version: 1 }), new Date(Date.now() - 60_000));
    await manager.start(botId);
    writeFileSync(join(home(), '.codex', 'auth.json'), fakeCodexAuth({ version: 2 }));
    await auth.afterCodexRun(botId);
    expect(readFileSync(shared, 'utf8')).toBe(fakeCodexAuth({ version: 2 }));
    expect(logLines.join('\n')).not.toContain('refresh-2');
  });

  it('GET /api/settings/engines returns typed statuses without secret values', async () => {
    setToken(FAKE_CLAUDE_TOKEN);
    const app = await buildServer({ ...loadConfig({}), logLevel: 'silent' }, { engineAuth: auth });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/settings/engines' });
      expect(res.statusCode).toBe(200);
      const body = engineSettingsResponseSchema.parse(res.json());
      expect(body.engines.map((e) => [e.engine, e.state])).toEqual([
        ['claude', 'configured'],
        ['codex', 'missing'],
      ]);
      expect(res.body).not.toContain(FAKE_CLAUDE_TOKEN);
      const bad = await app.inject({ method: 'GET', url: '/api/settings/engines?verify=maybe' });
      expect(bad.statusCode).toBe(400);
      const verified = await app.inject({ method: 'GET', url: '/api/settings/engines?verify=1' });
      expect(verified.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
