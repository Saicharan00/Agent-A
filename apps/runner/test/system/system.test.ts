import { join } from 'node:path';
import { DEFAULT_BOT_DEFAULTS, ONBOARDING_HELLO } from '@agenta/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotService } from '../../src/bots/service';
import { loadConfig } from '../../src/config';
import { MockEngine } from '../../src/engines/mock';
import { buildServer } from '../../src/server';
import type { DoctorProbes } from '../../src/system/doctor';
import { ImageBuilder } from '../../src/system/image-build';
import { ThreadService } from '../../src/threads/service';
import { type Harness, makeHarness, silent } from '../runs/helpers';

const paths = {
  data: '/d',
  db: '/d/agenta.db',
  bots: '/d/bots',
  shared: '/d/shared',
  secrets: '/d/secrets',
  backups: '/d/backups',
};

const fakeProbes = (): DoctorProbes => ({
  nodeVersion: 'v22.22.1',
  env: { IS_SANDBOX: '1' },
  run: async () => null,
  freeBytes: async () => 100e9,
  portState: async () => 'free',
  integrity: () => 'ok',
  engines: async () => [],
  repoRoot: '/repo',
  dataDir: '/d',
  ports: { web: 3000, runner: 3001, mcp: 3002 },
});

/** Resolves once the builder leaves `running`. */
async function settled(b: ImageBuilder) {
  await vi.waitFor(() => expect(b.current().state).not.toBe('running'), { timeout: 5000 });
  return b.current();
}

describe('ImageBuilder', () => {
  const node = (code: string): [string, string[]] => [process.execPath, ['-e', code]];

  it('streams output lines and records success; refuses a second build while running', async () => {
    const b = new ImageBuilder({
      cwd: process.cwd(),
      log: silent,
      command: node(
        'console.log("step 1"); console.error("warn 2"); setTimeout(() => process.stdout.write("done"), 50)',
      ),
    });
    expect(b.start()).toBe(true);
    expect(b.start()).toBe(false);
    const s = await settled(b);
    expect(s).toMatchObject({ state: 'succeeded', exitCode: 0 });
    expect(s.log).toEqual(expect.arrayContaining(['step 1', 'warn 2', 'done']));
    expect(s.finishedAt).not.toBeNull();
  });

  it('records a failed build and keeps only the last lines', async () => {
    const b = new ImageBuilder({
      cwd: process.cwd(),
      log: silent,
      command: node('for (let i = 0; i < 1000; i++) console.log("line " + i); process.exit(3)'),
    });
    b.start();
    const s = await settled(b);
    expect(s).toMatchObject({ state: 'failed', exitCode: 3 });
    expect(s.log).toHaveLength(400);
    expect(s.log.at(-1)).toBe('line 999');
  });

  it('a missing command fails with a message', async () => {
    const b = new ImageBuilder({ cwd: process.cwd(), log: silent, command: ['agenta-no-such-cmd', []] });
    b.start();
    const s = await settled(b);
    expect(s.state).toBe('failed');
    expect(s.log.join('\n')).toMatch(/Could not start the build/);
  });
});

describe('system API', () => {
  const config = { ...loadConfig({}), logLevel: 'silent' as const };
  let h: Harness;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    h = makeHarness({ adapters: [new MockEngine({ slowMs: 60_000, tickMs: 1 })] });
    const botsDir = join(h.dir, 'bots');
    const bots = new BotService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      runs: h.service,
      teamDir: config.teamDir,
    });
    const threads = new ThreadService({
      repos: h.repos,
      bus: h.bus,
      log: silent,
      botsDir,
      bots,
      runs: h.service,
    });
    const images = new ImageBuilder({
      cwd: process.cwd(),
      log: silent,
      command: [process.execPath, ['-e', '']],
    });
    app = await buildServer(config, {
      repos: h.repos,
      runs: h.service,
      bots,
      threads,
      system: { probes: fakeProbes, images, paths },
    });
  });
  afterEach(async () => {
    await app.close();
    h.close();
  });

  it('GET /api/doctor returns the report', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/doctor' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      insideSandbox: true,
      checks: expect.arrayContaining([expect.objectContaining({ id: 'db', status: 'ok' })]),
    });
  });

  it('app settings: defaults, save, validation; new team bots get the resource defaults', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/settings/app' });
    expect(first.json()).toEqual({ timezone: 'America/New_York', botDefaults: DEFAULT_BOT_DEFAULTS, paths });

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/app',
      payload: { timezone: 'Mars/Base' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_body');

    const botDefaults = { cpus: 1, memoryMb: 1024, idleTimeoutMin: 10 };
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings/app',
      payload: { timezone: 'Asia/Kolkata', botDefaults },
    });
    expect(saved.json()).toMatchObject({ timezone: 'Asia/Kolkata', botDefaults });

    await app.inject({ method: 'POST', url: '/api/onboarding/team' });
    expect(h.repos.bots.getLead()!.settings).toMatchObject(botDefaults);
  });

  it('POST /api/onboarding/team creates the team and says hello to Agent A in its DM', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/onboarding/team' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(7);
    const lead = h.repos.bots.getLead()!;
    expect(body.leadThreadId).toBe(h.repos.threads.findDm(lead.id)!.id);
    const page = await app.inject({ method: 'GET', url: `/api/threads/${body.leadThreadId}/messages` });
    expect(page.json().messages.map((m: { contentMd: string }) => m.contentMd)).toContain(ONBOARDING_HELLO);
    expect(h.repos.runs.list({ botId: lead.id })).toHaveLength(1);
  });

  it('image build: start, status, 409 while running', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/image/build' });
    expect(start.json().state).toBe('running');
    expect((await app.inject({ method: 'POST', url: '/api/image/build' })).statusCode).toBe(409);
    await vi.waitFor(async () => {
      const s = await app.inject({ method: 'GET', url: '/api/image/build' });
      expect(s.json().state).toBe('succeeded');
    });
  });
});
