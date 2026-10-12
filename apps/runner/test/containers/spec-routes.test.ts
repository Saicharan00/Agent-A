import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import { apiErrorSchema, computerStatusSchema, healthResponseSchema } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/bus';
import { loadConfig } from '../../src/config';
import { botHomeDir, checkSymlinks, wipeHome } from '../../src/containers/home';
import { ContainerManager } from '../../src/containers/manager';
import { proxyEnv, statusFromContainer } from '../../src/containers/spec';
import { buildServer } from '../../src/server';
import { FakeDocker } from './fake-docker';

describe('container spec helpers', () => {
  it('proxyEnv forwards proxy vars and always bypasses host.docker.internal', () => {
    const env = proxyEnv({ HTTPS_PROXY: 'http://gw:3128', NO_PROXY: 'localhost,gw', SECRET: 'x' });
    expect(env).toContain('HTTPS_PROXY=http://gw:3128');
    const noProxy = env.find((e) => e.startsWith('NO_PROXY='))!;
    expect(noProxy.split('=')[1]!.split(',')).toEqual(
      expect.arrayContaining(['localhost', 'gw', '127.0.0.1', 'host.docker.internal']),
    );
    expect(env.join(' ')).not.toContain('SECRET');
    expect(proxyEnv({})).toEqual([]);
  });

  it('maps docker state to bot status', () => {
    const c = { id: 'x', name: 'x', labels: {}, hostPort: null };
    expect(statusFromContainer(null)).toBe('stopped');
    expect(statusFromContainer({ ...c, state: 'running', health: 'healthy' })).toBe('running');
    expect(statusFromContainer({ ...c, state: 'running', health: 'starting' })).toBe('starting');
    expect(statusFromContainer({ ...c, state: 'running', health: 'unhealthy' })).toBe('error');
    expect(statusFromContainer({ ...c, state: 'exited', health: 'none' })).toBe('stopped');
    expect(statusFromContainer({ ...c, state: 'dead', health: 'none' })).toBe('error');
  });

  it('wipeHome refuses paths outside the bots dir; botHomeDir validates ids', () => {
    expect(() => wipeHome('/data/bots', '/etc')).toThrow(/Refusing/);
    expect(() => botHomeDir('/data/bots', '../etc')).toThrow(/Invalid bot id/);
    expect(botHomeDir('/data/bots', 'bot_abc')).toBe('/data/bots/bot_abc/home');
  });

  it('checkSymlinks passes on a normal temp dir', () => {
    const d = mkdtempSync(join(tmpdir(), 'agenta-sym-'));
    expect(checkSymlinks(d)).toBeNull();
    rmSync(d, { recursive: true, force: true });
  });
});

describe('computer routes', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let docker: FakeDocker;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let botId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-routes-'));
    db = openDb(join(dir, 'test.db'));
    repos = createRepos(db);
    docker = new FakeDocker();
    const containers = new ContainerManager({
      docker,
      repos,
      bus: new EventBus(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      botsDir: join(dir, 'bots'),
      sharedDir: join(dir, 'shared'),
      healthPollMs: 1,
    });
    app = await buildServer({ ...loadConfig({}), logLevel: 'silent' }, { repos, containers });
    botId = repos.bots.create({ name: 'Echo', engine: 'mock' }).id;
  });

  afterEach(async () => {
    await app.close();
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('start → status → stop', async () => {
    const start = await app.inject({ method: 'POST', url: `/api/bots/${botId}/computer/start` });
    expect(start.statusCode).toBe(200);
    expect(computerStatusSchema.parse(start.json()).status).toBe('running');

    const get = await app.inject({ method: 'GET', url: `/api/bots/${botId}/computer` });
    expect(get.json()).toMatchObject({ status: 'running', health: 'healthy' });

    const stop = await app.inject({ method: 'POST', url: `/api/bots/${botId}/computer/stop` });
    expect(stop.json()).toMatchObject({ status: 'stopped', novncPort: null });
  });

  it('reset with wipeHome requires confirm: true', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/computer/reset`,
      payload: { wipeHome: true },
    });
    expect(bad.statusCode).toBe(400);
    expect(apiErrorSchema.parse(bad.json()).error.code).toBe('confirm_required');

    const ok = await app.inject({
      method: 'POST',
      url: `/api/bots/${botId}/computer/reset`,
      payload: { wipeHome: true, confirm: true },
    });
    expect(ok.statusCode).toBe(200);

    const keep = await app.inject({ method: 'POST', url: `/api/bots/${botId}/computer/reset` });
    expect(keep.statusCode).toBe(200);
  });

  it('typed errors: unknown bot 404, missing image 503, docker down 503', async () => {
    const nf = await app.inject({ method: 'POST', url: '/api/bots/bot_nope/computer/start' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('bot_not_found');

    docker.imagePresent = false;
    const img = await app.inject({ method: 'POST', url: `/api/bots/${botId}/computer/start` });
    expect(img.statusCode).toBe(503);
    expect(img.json().error.code).toBe('image_missing');

    docker.down = true;
    const down = await app.inject({ method: 'GET', url: `/api/bots/${botId}/computer` });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe('docker_unavailable');
  });

  it('/api/health includes docker status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    const body = healthResponseSchema.parse(res.json());
    expect(body.docker).toEqual({ ok: true, version: '29.0.0-fake', image: true });
  });
});
