// @docker — real Docker integration test (pnpm test:docker). Needs agenta-bot:latest (pnpm image:build).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus';
import { createDockerApi } from '../src/containers/docker';
import { ContainerManager } from '../src/containers/manager';
import { proxyEnv } from '../src/containers/spec';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function run(manager: ContainerManager, botId: string, script: string) {
  const h = await manager.exec(botId, { cmd: ['bash', '-lc', script] });
  let stdout = '';
  let stderr = '';
  h.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
  h.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const code = await h.wait();
  return { code, stdout, stderr };
}

type Inspect = {
  State: { Status: string };
  Config: { User: string; Labels: Record<string, string> };
  HostConfig: {
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop: string[];
    CapAdd: string[] | null;
    SecurityOpt: string[];
    Privileged: boolean;
    NetworkMode: string;
    ExtraHosts: string[];
    PortBindings: Record<string, { HostIp: string; HostPort: string }[]>;
  };
  Mounts: { Destination: string }[];
};

function inspect(id: string): Inspect {
  return (JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' })) as Inspect[])[0]!;
}

describe('@docker bot computer lifecycle', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let manager: ContainerManager;
  let botId: string;
  const containerIds = new Set<string>();

  beforeAll(() => {
    // VM disk (supports symlinks), never the repo's data/ folder.
    dir = mkdtempSync(join(tmpdir(), 'agenta-docker-'));
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
    botId = repos.bots.create({
      name: `F05 Lifecycle ${Date.now().toString(36)}`,
      engine: 'mock',
      settings: { cpus: 1.5, memoryMb: 1024 },
    }).id;
  });

  afterAll(async () => {
    const docker = createDockerApi();
    const bot = repos.bots.get(botId);
    if (bot?.containerId) containerIds.add(bot.containerId);
    for (const id of containerIds) await docker.remove(id);
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('create → start → exec → stop → start → persists → reset(keep) → reset(wipe)', async () => {
    const started = await manager.start(botId);
    containerIds.add(started.containerId!);
    expect(started).toMatchObject({ status: 'running', health: 'healthy' });
    expect(started.novncPort).toBeGreaterThan(0);

    // noVNC is reachable on the published 127.0.0.1 port
    const res = await fetch(`http://127.0.0.1:${started.novncPort}/vnc.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('noVNC');

    const hi = await run(manager, botId, 'echo hi && whoami');
    expect(hi).toMatchObject({ code: 0, stdout: 'hi\nbot\n' });
    const err = await run(manager, botId, 'echo oops >&2; exit 3');
    expect(err).toMatchObject({ code: 3, stdout: '', stderr: 'oops\n' });

    // symlinks + a Python venv work in the home (the reason homes live on the VM disk)
    const venv = await run(manager, botId, 'cd ~/work && python3 -m venv v && ln -s v link && echo ok');
    expect(venv.stdout.trim()).toBe('ok');

    await manager.stop(botId);
    expect(repos.bots.get(botId)!.status).toBe('stopped');
    expect(inspect(started.containerId!).State.Status).toBe('exited');

    const again = await manager.start(botId);
    expect(again.containerId).toBe(started.containerId);
    await run(manager, botId, 'echo persisted > ~/work/note.txt');
    await manager.stop(botId);
    await manager.start(botId);
    expect((await run(manager, botId, 'cat ~/work/note.txt')).stdout).toBe('persisted\n');

    const kept = await manager.reset(botId, { wipeHome: false });
    containerIds.add(kept.containerId!);
    expect(kept.containerId).not.toBe(started.containerId);
    expect(kept.status).toBe('running');
    expect((await run(manager, botId, 'cat ~/work/note.txt')).stdout).toBe('persisted\n');

    const wiped = await manager.reset(botId, { wipeHome: true });
    containerIds.add(wiped.containerId!);
    expect((await run(manager, botId, 'test -e ~/work/note.txt && echo still || echo gone')).stdout).toBe(
      'gone\n',
    );
    expect(existsSync(join(dir, 'bots', botId, 'home', 'work'))).toBe(true);
  }, 300_000);

  it('container has the expected limits and hardening (docker inspect)', async () => {
    const { containerId } = await manager.status(botId);
    const c = inspect(containerId!);
    const hc = c.HostConfig;
    expect(hc.Memory).toBe(1024 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(1.5e9);
    expect(hc.PidsLimit).toBe(512);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.CapAdd ?? []).toEqual([]);
    expect(hc.SecurityOpt).toContain('no-new-privileges');
    expect(hc.Privileged).toBe(false);
    expect(hc.NetworkMode).toBe('agenta-net');
    expect(hc.ExtraHosts[0]).toMatch(/^host\.docker\.internal:\d+\.\d+\.\d+\.\d+$/);
    expect(hc.PortBindings['6080/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '' }]);
    expect(c.Config.User).toBe('bot');
    expect(c.Config.Labels).toMatchObject({ agenta: '1', 'agenta.bot': botId });
    const mounts = c.Mounts.map((m) => m.Destination).sort();
    expect(mounts).toEqual(['/home/bot', '/shared']);
    expect(JSON.stringify(c)).not.toContain('docker.sock');
  });

  it('reconcile adopts the running container after a "runner restart"', async () => {
    const before = repos.bots.get(botId)!;
    repos.bots.updateRuntime(botId, { status: 'stopped', containerId: null, novncPort: null });
    const fresh = new ContainerManager({
      docker: createDockerApi(),
      repos,
      bus: new EventBus(),
      log: silent,
      botsDir: join(dir, 'bots'),
      sharedDir: join(dir, 'shared'),
    });
    const report = await fresh.reconcile();
    expect(report.adopted).toContain(botId);
    expect(repos.bots.get(botId)).toMatchObject({
      status: 'running',
      containerId: before.containerId,
      novncPort: before.novncPort,
    });
  });
});
