// Launches the Next.js CLI with the repo-root .env.local loaded and the bind host/port
// taken from AGENTA_WEB_HOST / AGENTA_WEB_PORT (default 127.0.0.1:3000).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(webDir, '..', '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [command = 'dev', ...rest] = process.argv.slice(2);
const host = process.env.AGENTA_WEB_HOST || '127.0.0.1';
const port = process.env.AGENTA_WEB_PORT || '3000';
const args = command === 'build' ? ['build', ...rest] : [command, '-H', host, '-p', port, ...rest];

const nextBin = createRequire(join(webDir, 'package.json')).resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, ...args], {
  cwd: webDir,
  stdio: 'inherit',
  env: { NEXT_TELEMETRY_DISABLED: '1', ...process.env },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
