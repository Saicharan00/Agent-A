import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import {
  BOT_IMAGE,
  type DoctorCheck,
  type DoctorReport,
  type EngineAuthStatus,
  healthResponseSchema,
} from '@agenta/shared';

export type PortState = 'free' | 'agenta' | 'other';

/** Everything the doctor looks at, injected so the checks are testable without a real machine. */
export type DoctorProbes = {
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  /** Trimmed stdout of a command, or null if it failed or isn't installed. */
  run(cmd: string, args: string[]): Promise<string | null>;
  /** Free bytes on the filesystem holding `dir`, or null if unknown. */
  freeBytes(dir: string): Promise<number | null>;
  portState(port: number): Promise<PortState>;
  /** `PRAGMA integrity_check` result ('ok' when healthy), or null when there is no DB yet. */
  integrity(): string | null;
  engines(): Promise<EngineAuthStatus[]>;
  repoRoot: string;
  dataDir: string;
  ports: { web: number; runner: number; mcp: number };
};

const GB = 1e9;
const NODE_RANGE = { major: 22, minMinor: 12 };
const IMAGE_REVISION_LABEL = 'org.opencontainers.image.revision';

function check(
  id: string,
  label: string,
  status: DoctorCheck['status'],
  summary: string,
  fix: string[] = [],
): DoctorCheck {
  return { id, label, status, summary, fix };
}

function nodeCheck(version: string): DoctorCheck {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  const ok = major === NODE_RANGE.major && minor >= NODE_RANGE.minMinor;
  return ok
    ? check('node', 'Node.js', 'ok', version)
    : check('node', 'Node.js', 'fail', `${version} (needs Node 22.12 or newer 22.x)`, [
        'Install Node 22 LTS in the sandbox as recorded in docs/DECISIONS.md (F01), then open a new shell.',
      ]);
}

async function pnpmCheck(p: DoctorProbes): Promise<DoctorCheck> {
  const v = await p.run('pnpm', ['--version']);
  return v
    ? check('pnpm', 'pnpm', 'ok', v)
    : check('pnpm', 'pnpm', 'fail', 'not found', [
        'Run `corepack enable` in the sandbox, then `pnpm --version`.',
      ]);
}

async function dockerCheck(p: DoctorProbes): Promise<{ check: DoctorCheck; up: boolean }> {
  const client = await p.run('docker', ['version', '--format', '{{.Client.Version}}']);
  if (!client)
    return {
      up: false,
      check: check('docker', 'Docker', 'fail', 'docker CLI not found', [
        'Install the Docker CLI in the sandbox VM (it ships with the Docker Sandbox image).',
      ]),
    };
  const server = await p.run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (!server)
    return {
      up: false,
      check: check('docker', 'Docker', 'fail', `client ${client}, daemon not reachable`, [
        "Run `docker version` in the sandbox: the sandbox's private Docker daemon must be running.",
        'If it is stopped, restart the sandbox from Windows: `sbx run --name agent-a`.',
      ]),
    };
  return { up: true, check: check('docker', 'Docker', 'ok', `client ${client}, daemon ${server}`) };
}

function sandboxCheck(env: NodeJS.ProcessEnv): DoctorCheck {
  const name = env.SANDBOX_NAME || env.SANDBOX_VM_ID;
  if (env.IS_SANDBOX === '1' || env.SANDBOX_ID || name)
    return check('sandbox', 'Docker Sandbox VM', 'ok', `running inside sandbox ${name ?? '(unnamed)'}`);
  return check(
    'sandbox',
    'Docker Sandbox VM',
    'warn',
    'NOT running inside the Docker Sandbox VM: bots would get containers on this machine directly',
    [
      'Stop Agent A here. Run it only inside the sandbox: on Windows, `sbx run --name agent-a`, then start it from the sandbox shell.',
    ],
  );
}

async function diskCheck(p: DoctorProbes): Promise<DoctorCheck> {
  const free = await p.freeBytes(p.dataDir);
  if (free === null) return check('disk', 'Disk space (data/)', 'warn', 'could not read free space');
  const summary = `${(free / GB).toFixed(1)} GB free for ${p.dataDir}`;
  const fix = [
    'Free up space in the sandbox (old bot images: `docker image ls agenta-bot`), or delete old backups.',
  ];
  if (free < 2 * GB) return check('disk', 'Disk space (data/)', 'fail', summary, fix);
  if (free < 10 * GB) return check('disk', 'Disk space (data/)', 'warn', summary, fix);
  return check('disk', 'Disk space (data/)', 'ok', summary);
}

async function imageCheck(p: DoctorProbes, dockerUp: boolean): Promise<DoctorCheck> {
  const label = `Bot image (${BOT_IMAGE})`;
  const build = ['Run `pnpm image:build` in the sandbox (or use "Build image" in Settings).'];
  if (!dockerUp) return check('image', label, 'warn', 'not checked: Docker is not reachable');
  const rev = await p.run('docker', [
    'image',
    'inspect',
    BOT_IMAGE,
    '--format',
    `{{index .Config.Labels "${IMAGE_REVISION_LABEL}"}}`,
  ]);
  if (rev === null) return check('image', label, 'fail', 'not built yet', build);
  const sha = rev.replace(/-dirty$/, '');
  if (!sha || sha === '<no value>' || sha === 'nogit')
    return check('image', label, 'ok', 'present (revision unknown)');
  // Up to date = nothing under docker/bot changed since the commit the image was built from.
  const changed = await p.run('git', ['-C', p.repoRoot, 'diff', '--name-only', sha, '--', 'docker/bot']);
  if (changed === null) return check('image', label, 'ok', `present, built from ${sha}`);
  if (changed !== '')
    return check('image', label, 'warn', `out of date: docker/bot changed since ${sha}`, [
      ...build,
      'Then reset each bot computer (bot page → Reset) so it uses the new image.',
    ]);
  if (rev.endsWith('-dirty'))
    return check('image', label, 'warn', `built from uncommitted docker/bot changes on ${sha}`, build);
  return check('image', label, 'ok', `up to date (built from ${sha})`);
}

async function portsCheck(p: DoctorProbes): Promise<DoctorCheck> {
  const names = { web: 'web', runner: 'runner', mcp: 'MCP' } as const;
  const states = await Promise.all(
    (Object.keys(names) as (keyof typeof names)[]).map(async (k) => ({
      key: k,
      port: p.ports[k],
      state: await p.portState(p.ports[k]),
    })),
  );
  const parts = states.map((s) => `${s.port} ${s.state === 'agenta' ? 'Agent A' : s.state}`);
  const taken = states.filter((s) => s.state === 'other');
  if (taken.length === 0) return check('ports', 'Ports', 'ok', parts.join(', '));
  return check(
    'ports',
    'Ports',
    'fail',
    parts.join(', '),
    taken.map(
      (s) =>
        `Port ${s.port} (${names[s.key]}) is used by another program: find it with \`ss -ltnp | grep :${s.port}\` and stop it.`,
    ),
  );
}

function dbCheck(p: DoctorProbes): DoctorCheck {
  let result: string | null;
  try {
    result = p.integrity();
  } catch (err) {
    result = (err as Error).message;
  }
  if (result === null) return check('db', 'Database', 'ok', 'not created yet (made on first start)');
  if (result === 'ok') return check('db', 'Database', 'ok', 'integrity check ok');
  return check('db', 'Database', 'fail', `integrity check: ${result.split('\n')[0]}`, [
    'Stop Agent A and restore the latest backup from data/backups/ (F32), or move data/agenta.db aside to start fresh.',
  ]);
}

const ENGINE_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;

async function engineChecks(p: DoctorProbes): Promise<DoctorCheck[]> {
  let statuses: EngineAuthStatus[];
  try {
    statuses = await p.engines();
  } catch (err) {
    return [check('engines', 'Engine sign-in', 'warn', `could not check: ${(err as Error).message}`)];
  }
  return statuses.map((s) =>
    check(
      `engine-${s.engine}`,
      `${ENGINE_NAMES[s.engine]} sign-in`,
      s.state === 'configured' ? 'ok' : 'warn',
      s.detail,
      s.state === 'configured' ? [] : s.fix,
    ),
  );
}

/** Runs every check. Never throws: a failing probe becomes a failing check. */
export async function runDoctor(p: DoctorProbes, now = new Date()): Promise<DoctorReport> {
  const docker = await dockerCheck(p);
  const checks = [
    sandboxCheck(p.env),
    nodeCheck(p.nodeVersion),
    await pnpmCheck(p),
    docker.check,
    await imageCheck(p, docker.up),
    await diskCheck(p),
    await portsCheck(p),
    dbCheck(p),
    ...(await engineChecks(p)),
  ];
  return {
    ok: checks.every((c) => c.status !== 'fail'),
    insideSandbox: checks[0]!.status === 'ok',
    checks,
    generatedAt: now.toISOString(),
  };
}

const MARK = { ok: '✓', warn: '!', fail: '✗' } as const;

/** Plain-text report for `pnpm doctor`. */
export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  if (!report.insideSandbox) {
    lines.push('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    lines.push('!! WARNING: Agent A is NOT running inside the Docker Sandbox VM.         !!');
    lines.push('!! It must only run inside the `agent-a` sandbox. See the fix below.     !!');
    lines.push('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    lines.push('');
  }
  lines.push('Agent A doctor');
  const width = Math.max(...report.checks.map((c) => c.label.length));
  for (const c of report.checks) {
    lines.push(`  ${MARK[c.status]} ${c.label.padEnd(width)}  ${c.summary}`);
    for (const step of c.fix) lines.push(`      fix: ${step}`);
  }
  const fails = report.checks.filter((c) => c.status === 'fail').length;
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    fails || warns ? `${fails} problem(s), ${warns} warning(s).` : 'All checks passed. Agent A is ready.',
  );
  return lines.join('\n');
}

// ---------- real probes ----------

export function runCommand(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 15_000 }, (err, stdout) =>
      resolve(err ? null : stdout.trim()),
    );
  });
}

export async function freeBytes(dir: string): Promise<number | null> {
  let d = dir;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  try {
    const s = await statfs(d);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

function listenable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/**
 * Free, Agent A (its /api/health answers, directly on the runner port or through the web proxy), or another program.
 * `self` ports belong to the calling runner. The MCP port counts as Agent A's when the runner answers.
 */
export async function probePort(
  port: number,
  opts: { self?: number[]; runnerPort?: number; isAgentA?: (port: number) => Promise<boolean> } = {},
): Promise<PortState> {
  if (opts.self?.includes(port)) return 'agenta';
  const isAgentA = opts.isAgentA ?? agentAHealth;
  if (await isAgentA(port)) return 'agenta';
  if (await listenable(port, '127.0.0.1')) return 'free';
  if (opts.runnerPort !== undefined && port !== opts.runnerPort && (await isAgentA(opts.runnerPort)))
    return 'agenta';
  return 'other';
}

/** The real machine's probes, for the runner's /api/doctor and `pnpm doctor`. */
export function realProbes(o: {
  repoRoot: string;
  dataDir: string;
  ports: DoctorProbes['ports'];
  /** Ports the calling process listens on itself. */
  selfPorts?: number[];
  integrity: () => string | null;
  engines: () => Promise<EngineAuthStatus[]>;
}): DoctorProbes {
  return {
    nodeVersion: process.version,
    env: process.env,
    run: runCommand,
    freeBytes,
    portState: (port) => probePort(port, { self: o.selfPorts, runnerPort: o.ports.runner }),
    integrity: o.integrity,
    engines: o.engines,
    repoRoot: o.repoRoot,
    dataDir: o.dataDir,
    ports: o.ports,
  };
}

async function agentAHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return healthResponseSchema.safeParse(await res.json()).success;
  } catch {
    return false;
  }
}
