import type { EngineAuthStatus } from '@agenta/shared';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { type DoctorProbes, formatDoctor, probePort, runDoctor } from '../../src/system/doctor';

const engine = (e: 'claude' | 'codex', configured: boolean): EngineAuthStatus => ({
  engine: e,
  state: configured ? 'configured' : 'missing',
  mode: configured ? 'token' : 'none',
  detail: configured ? `${e} signed in` : `${e} not set up`,
  fix: configured ? [] : [`run pnpm auth:${e}`],
  perBotLogins: [],
  cli: { checked: false },
  checkedAt: '2026-10-15T09:00:00.000Z',
});

/** A healthy machine; `over` swaps in broken parts. */
function probes(
  over: Partial<DoctorProbes> = {},
  commands: Record<string, string | null> = {},
): DoctorProbes {
  const outputs: Record<string, string | null> = {
    'pnpm --version': '10.34.7',
    'docker version --format {{.Client.Version}}': '29.8.1',
    'docker version --format {{.Server.Version}}': '29.8.1',
    'docker image inspect agenta-bot:latest --format {{index .Config.Labels "org.opencontainers.image.revision"}}':
      'abc123def456',
    'git -C /repo diff --name-only abc123def456 -- docker/bot': '',
    ...commands,
  };
  return {
    nodeVersion: 'v22.22.1',
    env: { IS_SANDBOX: '1', SANDBOX_NAME: 'agent-a' },
    run: async (cmd, args) => {
      const key = [cmd, ...args].join(' ');
      return key in outputs ? outputs[key]! : null;
    },
    freeBytes: async () => 250e9,
    portState: async (port) => (port === 3000 || port === 3001 ? 'agenta' : 'free'),
    integrity: () => 'ok',
    engines: async () => [engine('claude', true), engine('codex', true)],
    repoRoot: '/repo',
    dataDir: '/repo/data',
    ports: { web: 3000, runner: 3001, mcp: 3002 },
    ...over,
  };
}

const NOW = new Date('2026-10-15T09:00:00.000Z');
const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)!;

describe('doctor', () => {
  it('healthy setup: every check ok (output snapshot)', async () => {
    const report = await runDoctor(probes(), NOW);
    expect(report.ok).toBe(true);
    expect(report.insideSandbox).toBe(true);
    expect(report.checks.every((c) => c.status === 'ok')).toBe(true);
    expect(formatDoctor(report)).toMatchInlineSnapshot(`
      "Agent A doctor
        ✓ Docker Sandbox VM              running inside sandbox agent-a
        ✓ Node.js                        v22.22.1
        ✓ pnpm                           10.34.7
        ✓ Docker                         client 29.8.1, daemon 29.8.1
        ✓ Bot image (agenta-bot:latest)  up to date (built from abc123def456)
        ✓ Disk space (data/)             250.0 GB free for /repo/data
        ✓ Ports                          3000 Agent A, 3001 Agent A, 3002 free
        ✓ Database                       integrity check ok
        ✓ Claude Code sign-in            claude signed in
        ✓ Codex sign-in                  codex signed in

      All checks passed. Agent A is ready."
    `);
  });

  it('warns loudly when not inside the Docker Sandbox VM', async () => {
    const report = await runDoctor(probes({ env: {} }), NOW);
    expect(report.insideSandbox).toBe(false);
    expect(byId(report, 'sandbox').status).toBe('warn');
    expect(formatDoctor(report)).toMatch(
      /^!+\n!! WARNING: Agent A is NOT running inside the Docker Sandbox VM/,
    );
  });

  it('Docker daemon down: fails Docker and skips the image check', async () => {
    const report = await runDoctor(probes({}, { 'docker version --format {{.Server.Version}}': null }), NOW);
    expect(report.ok).toBe(false);
    expect(byId(report, 'docker')).toMatchObject({ status: 'fail', summary: /daemon not reachable/ });
    expect(byId(report, 'image')).toMatchObject({ status: 'warn', summary: /not checked/ });
  });

  it('image missing fails; changed docker/bot or a dirty build warns', async () => {
    const inspect =
      'docker image inspect agenta-bot:latest --format {{index .Config.Labels "org.opencontainers.image.revision"}}';
    const missing = await runDoctor(probes({}, { [inspect]: null }), NOW);
    expect(byId(missing, 'image')).toMatchObject({
      status: 'fail',
      fix: [expect.stringMatching(/image:build/)],
    });

    const stale = await runDoctor(
      probes({}, { 'git -C /repo diff --name-only abc123def456 -- docker/bot': 'docker/bot/Dockerfile' }),
      NOW,
    );
    expect(byId(stale, 'image')).toMatchObject({ status: 'warn', summary: /out of date/ });

    const dirty = await runDoctor(probes({}, { [inspect]: 'abc123def456-dirty' }), NOW);
    expect(byId(dirty, 'image')).toMatchObject({ status: 'warn', summary: /uncommitted/ });
  });

  it('low disk, a taken port, a corrupt DB and a missing engine login', async () => {
    const report = await runDoctor(
      probes({
        freeBytes: async () => 1e9,
        portState: async (p) => (p === 3002 ? 'other' : 'free'),
        integrity: () => '*** in database main ***\nPage 5 is never used',
        engines: async () => [engine('claude', false), engine('codex', true)],
      }),
      NOW,
    );
    expect(report.ok).toBe(false);
    expect(byId(report, 'disk').status).toBe('fail');
    expect(byId(report, 'ports')).toMatchObject({
      status: 'fail',
      fix: [expect.stringMatching(/3002.*ss -ltnp/)],
    });
    expect(byId(report, 'db')).toMatchObject({
      status: 'fail',
      summary: 'integrity check: *** in database main ***',
    });
    expect(byId(report, 'engine-claude')).toMatchObject({ status: 'warn', fix: ['run pnpm auth:claude'] });
    expect(byId(report, 'engine-codex').status).toBe('ok');
  });

  it('old Node fails; a missing DB is fine', async () => {
    const report = await runDoctor(probes({ nodeVersion: 'v20.11.0', integrity: () => null }), NOW);
    expect(byId(report, 'node').status).toBe('fail');
    expect(byId(report, 'db')).toMatchObject({ status: 'ok', summary: /not created yet/ });
  });
});

describe('probePort', () => {
  it('free, own, Agent A and other ports', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const taken = (srv.address() as { port: number }).port;
    try {
      const no = async () => false;
      expect(await probePort(taken, { isAgentA: no })).toBe('other');
      expect(await probePort(taken, { self: [taken], isAgentA: no })).toBe('agenta');
      expect(await probePort(taken, { isAgentA: async (p) => p === taken })).toBe('agenta');
      // The MCP port counts as Agent A's when the runner answers.
      expect(await probePort(taken, { runnerPort: 1, isAgentA: async (p) => p === 1 })).toBe('agenta');
    } finally {
      await new Promise((r) => srv.close(r));
    }
    expect(await probePort(taken, { isAgentA: async () => false })).toBe('free');
  });
});
