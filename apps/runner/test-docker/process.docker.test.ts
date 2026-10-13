// @docker — ContainerLauncher against a real bot computer (pnpm test:docker). No engine is called.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Db, type Repos, closeDb, createRepos, openDb } from '@agenta/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/bus';
import { createDockerApi } from '../src/containers/docker';
import { ContainerManager } from '../src/containers/manager';
import { proxyEnv } from '../src/containers/spec';
import { ContainerLauncher } from '../src/engines/process';

const silent = { debug() {}, info() {}, warn() {}, error() {} };

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let out = '';
  for await (const c of stream) out += (c as Buffer).toString();
  return out;
}

describe('@docker engine process launcher', () => {
  let dir: string;
  let db: Db;
  let repos: Repos;
  let manager: ContainerManager;
  let launcher: ContainerLauncher;
  let botId: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agenta-docker-proc-'));
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
    launcher = new ContainerLauncher((id, o) => manager.exec(id, o), join(dir, 'bots'));
    botId = repos.bots.create({ name: `F08 Proc ${Date.now().toString(36)}`, engine: 'mock' }).id;
  });

  afterAll(async () => {
    const id = repos.bots.get(botId)?.containerId;
    await manager.stop(botId).catch(() => undefined);
    if (id) await createDockerApi().remove(id);
    manager.stopLoops();
    closeDb(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('feeds stdin from a home file, passes exec env and argv verbatim', async () => {
    await manager.start(botId);
    const path = launcher.writeHomeFile(botId, '.agenta/runs/t1/prompt.md', 'line one\n"quoted" $HOME `x`\n');
    expect(path).toBe('/home/bot/.agenta/runs/t1/prompt.md');
    expect(launcher.homeFileExists(botId, path)).toBe(true);
    expect(launcher.homeFileExists(botId, '/home/bot/.agenta/nope.json')).toBe(false);
    const p = await launcher.spawn(botId, {
      cmd: ['bash', '-c', 'cat; echo "arg=$1 env=$SECRET_X pwd=$(pwd)"', 'bash', "it's $1 ok"],
      env: { SECRET_X: 'v1' },
      workdir: '/home/bot/work',
      stdinFile: path,
    });
    const [out, code] = await Promise.all([collect(p.stdout), p.wait()]);
    expect(code).toBe(0);
    expect(out).toBe(`line one\n"quoted" $HOME \`x\`\narg=it's $1 ok env=v1 pwd=/home/bot/work\n`);
    launcher.removeHomeFile(botId, '.agenta/runs/t1');
    expect(launcher.homeFileExists(botId, path)).toBe(false);
  });

  async function sleepers(): Promise<string> {
    const ps = await manager.exec(botId, { cmd: ['bash', '-c', 'pgrep -f "sleep 30[01]" || true'] });
    const [left] = await Promise.all([collect(ps.stdout), ps.wait()]);
    return left.trim();
  }

  it('SIGINT ends the CLI; a group SIGKILL reaps every process it started', async () => {
    const p = await launcher.spawn(botId, {
      cmd: ['bash', '-c', 'sleep 300 & sleep 301 & echo started; wait'],
      workdir: '/home/bot',
    });
    const out = collect(p.stdout);
    await new Promise((r) => setTimeout(r, 1500));
    await p.signal('INT');
    const code = await p.wait();
    expect(await out).toContain('started');
    expect(code).not.toBe(0);
    // Background jobs of a non-interactive shell ignore SIGINT; the follow-up group SIGKILL reaps them.
    expect(await sleepers()).not.toBe('');
    await p.signal('KILL');
    await new Promise((r) => setTimeout(r, 500));
    expect(await sleepers()).toBe('');
    await p.dispose();
  });

  it('SIGKILL ends a process that ignores SIGINT', async () => {
    const p = await launcher.spawn(botId, {
      cmd: ['bash', '-c', 'trap "" INT; echo up; sleep 300 & wait; sleep 300'],
      workdir: '/home/bot',
    });
    const out = collect(p.stdout);
    await new Promise((r) => setTimeout(r, 1500));
    await p.signal('INT');
    const stillRunning = await Promise.race([
      p.wait().then(() => false),
      new Promise((r) => setTimeout(() => r(true), 1500)),
    ]);
    expect(stillRunning).toBe(true);
    await p.signal('KILL');
    expect(await p.wait()).not.toBe(0);
    expect(await out).toContain('up');
  });
});
