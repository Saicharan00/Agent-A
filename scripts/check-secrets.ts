// Fails if staged files (or the paths given as args) contain likely secrets or runtime data.
// Usage: pnpm check:secrets            -> scans files staged in git
//        pnpm check:secrets -- a b c   -> scans the given files on disk
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export type Finding = { file: string; line?: number; rule: string };

const CONTENT_RULES: { rule: string; re: RegExp }[] = [
  { rule: 'openai/anthropic-style key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { rule: 'GitHub classic token (ghp_…)', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { rule: 'GitHub fine-grained token (github_pat_…)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { rule: 'Claude Code OAuth token assignment', re: /CLAUDE_CODE_OAUTH_TOKEN\s*=\s*['"]?[^\s'"#]{8,}/ },
  { rule: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Files whose content must never be scanned for rule matches (they define the rules). */
const CONTENT_ALLOWLIST = new Set(['scripts/check-secrets.ts']);

export function checkPath(file: string): Finding[] {
  const p = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const findings: Finding[] = [];
  if (/(^|\/)data\//.test(p)) findings.push({ file: p, rule: 'runtime data path (data/)' });
  if (/(^|\/)secrets\//.test(p)) findings.push({ file: p, rule: 'secrets/ path' });
  const base = p.split('/').pop() ?? p;
  if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') findings.push({ file: p, rule: '.env file' });
  return findings;
}

export function scanText(file: string, text: string): Finding[] {
  if (CONTENT_ALLOWLIST.has(file)) return [];
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const { rule, re } of CONTENT_RULES) {
      if (re.test(line)) findings.push({ file, line: i + 1, rule });
    }
  });
  return findings;
}

function stagedFiles(): string[] {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

function readStaged(file: string): string {
  return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function run(args: string[]): Finding[] {
  const useStaged = args.length === 0;
  const files = useStaged ? stagedFiles() : args;
  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...checkPath(file));
    let text: string;
    try {
      text = useStaged ? readStaged(file) : readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // binary
    findings.push(...scanText(file.replace(/\\/g, '/'), text));
  }
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const findings = run(args);
  if (findings.length > 0) {
    console.error('check:secrets FAILED — possible secrets or runtime data:');
    for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.rule}`);
    process.exit(1);
  }
  console.log(`check:secrets OK (${args.length === 0 ? 'staged files' : `${args.length} file(s)`})`);
}
