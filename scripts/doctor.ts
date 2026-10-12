// Environment health check. Stub for now; expanded in F31.
import { execFileSync } from 'node:child_process';

function version(cmd: string, args: string[]): string {
  try {
    return (
      execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .trim()
        .split('\n')[0] ?? ''
    );
  } catch {
    return 'NOT FOUND';
  }
}

const checks: [string, string][] = [
  ['node', process.version],
  ['pnpm', version('pnpm', ['--version'])],
  ['docker client', version('docker', ['version', '--format', '{{.Client.Version}}'])],
  ['docker server', version('docker', ['version', '--format', '{{.Server.Version}}'])],
];

console.log('Agent A doctor');
for (const [name, v] of checks) console.log(`  ${name.padEnd(14)} ${v}`);
process.exit(checks.some(([, v]) => v === 'NOT FOUND') ? 1 : 0);
