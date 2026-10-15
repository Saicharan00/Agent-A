// Environment health check (F31). Usage: pnpm doctor [-- --json]
// Asks the running runner (/api/doctor) first; if it isn't running, runs the same checks here.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepos, openDb } from '../packages/db/src/index';
import { type DoctorReport, doctorReportSchema } from '../packages/shared/src/index';
import { loadRootEnv } from '../packages/shared/src/env';
import { loadConfig } from '../apps/runner/src/config';
import { EngineAuth } from '../apps/runner/src/engines/auth';
import { envFileSource } from '../apps/runner/src/engines/secrets';
import { formatDoctor, realProbes, runDoctor } from '../apps/runner/src/system/doctor';

async function fromRunner(port: number): Promise<DoctorReport | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/doctor`, { signal: AbortSignal.timeout(30_000) });
    const parsed = doctorReportSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function local(): Promise<DoctorReport> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const shellEnv = { ...process.env };
  loadRootEnv();
  const config = loadConfig();
  const dbExists = existsSync(config.dbPath);
  // Read only: the doctor never migrates the owner's DB (an empty in-memory one stands in when there is none).
  const db = openDb(dbExists ? config.dbPath : ':memory:', { migrate: !dbExists });
  const report = await runDoctor(
    realProbes({
      repoRoot,
      dataDir: dirname(config.dbPath),
      ports: { web: Number(process.env.AGENTA_WEB_PORT) || 3000, runner: config.port, mcp: config.mcpPort },
      integrity: () => (dbExists ? (db.$client.pragma('integrity_check', { simple: true }) as string) : null),
      engines: () =>
        new EngineAuth({
          secrets: envFileSource({ shellEnv, envFile: config.envFile }),
          secretsDir: config.secretsDir,
          botsDir: config.botsDir,
          repos: createRepos(db),
          log: { info() {}, warn() {}, debug() {} },
        }).statuses(),
    }),
  );
  db.$client.close();
  return report;
}

const port = Number(process.env.AGENTA_RUNNER_PORT) || 3001;
const report = (await fromRunner(port)) ?? (await local());
console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : formatDoctor(report));
process.exit(report.ok ? 0 : 1);
