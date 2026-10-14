// Confidentiality guard (F24): secrets (F22) plus emails, IP addresses, internal hosts, long pasted code and the
// owner's guard terms. Runs on composer sends, uploads, memory saves and carry-over briefs.
import { z } from 'zod';
import { GUARD_TERM_KINDS } from './enums';

export const guardFindingSchema = z.object({ kind: z.string(), label: z.string(), match: z.string() });
export type GuardFinding = z.infer<typeof guardFindingSchema>;

type Detector = { kind: string; label: string; re: RegExp };

const DETECTORS: Detector[] = [
  { kind: 'private_key', label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'api_key', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'api_key', label: 'OpenAI-style API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  {
    kind: 'api_key',
    label: 'GitHub token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  },
  { kind: 'api_key', label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'api_key', label: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'api_key', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'api_key', label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    kind: 'token',
    label: 'JSON web token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    kind: 'credential',
    label: 'credential assignment',
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret)\b["']?\s*[:=]\s*["']?[^\s"'`]{8,}/gi,
  },
];

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

// Long random-looking runs. Hex (hashes, ids) tops out at 4 bits/char, so the 4.3 bar skips it.
const CANDIDATE_RE = /[A-Za-z0-9+/_=-]{32,}/g;
const isRandomLooking = (s: string) =>
  entropy(s) > 4.3 && /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s);

/** Secrets in `text`: known key/token formats, private keys, credential assignments and high-entropy strings. */
export function findSecrets(text: string): GuardFinding[] {
  const found: GuardFinding[] = [];
  const seen = new Set<string>();
  const add = (f: GuardFinding) => {
    if (seen.has(f.match)) return;
    seen.add(f.match);
    found.push(f);
  };
  for (const d of DETECTORS)
    for (const m of text.matchAll(d.re)) add({ kind: d.kind, label: d.label, match: m[0] });
  for (const m of text.matchAll(CANDIDATE_RE))
    if (isRandomLooking(m[0]) && ![...seen].some((s) => s.includes(m[0]) || m[0].includes(s)))
      add({ kind: 'high_entropy', label: 'random-looking secret', match: m[0] });
  return found;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// Full 8-group form, or compressed with "::". Needs a digit and two groups so `cafe::face` or `Foo::bar` don't count.
const IPV6_RE =
  /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?![\w:])/gi;
const INTERNAL_HOST_RE = [
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:internal|corp|intranet|intra)\b/gi,
  /\bintranet\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi,
  /\b[a-z0-9-]+\.(?:sharepoint\.com|atlassian\.net)\b/gi,
];
/** Hosts every setup uses; not confidential. */
const PUBLIC_HOSTS = new Set(['host.docker.internal']);
const isPublicIp = (ip: string) => ip.startsWith('127.') || ip === '0.0.0.0';
/** A pasted code block longer than this (lines) looks like a chunk of a repo. */
export const GUARD_CODE_LINES = 150;
const FENCE_RE = /```[^\n]*\n[\s\S]*?```/g;
const CODE_LINE_RE =
  /[;{}()=,]\s*$|^\s*(?:import|export|from|def|class|function|const|let|var|return|if|for|while|#include|public|private|package|func)\b/;

/** One owner-defined guard term (company, codename, client); `regex` terms are matched case-insensitively. */
export type GuardTermLike = { term: string; kind: (typeof GUARD_TERM_KINDS)[number]; note?: string };

const lineCount = (s: string) => s.split('\n').length;

function codeBlocks(text: string): string[] {
  const fenced = [...text.matchAll(FENCE_RE)].map((m) => m[0]);
  if (fenced.length) return fenced.filter((b) => lineCount(b) - 2 > GUARD_CODE_LINES);
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length <= GUARD_CODE_LINES) return [];
  // shortcut: unfenced paste counts as code when half its lines look like code; tune if prose gets flagged.
  return lines.filter((l) => CODE_LINE_RE.test(l)).length * 2 >= lines.length ? [text] : [];
}

function termRegex(t: GuardTermLike): RegExp | null {
  try {
    return t.kind === 'regex'
      ? new RegExp(t.term, 'gi')
      : new RegExp(t.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  } catch {
    return null;
  }
}

/** Everything the guard flags in `text`: secrets, personal/internal identifiers, long code and guard terms. */
export function checkConfidential(text: string, terms: GuardTermLike[] = []): GuardFinding[] {
  const found = findSecrets(text);
  const seen = new Set(found.map((f) => f.match));
  const add = (kind: string, label: string, match: string) => {
    if (!match || seen.has(match) || [...seen].some((s) => s.includes(match))) return;
    seen.add(match);
    found.push({ kind, label, match });
  };
  for (const t of terms) {
    const re = termRegex(t);
    if (re)
      for (const m of text.matchAll(re))
        add('guard_term', t.note ? `guard term (${t.note})` : 'guard term', m[0]);
  }
  for (const b of codeBlocks(text)) add('code_block', `long code block (over ${GUARD_CODE_LINES} lines)`, b);
  for (const m of text.matchAll(EMAIL_RE)) if (!m[0].startsWith('git@')) add('email', 'email address', m[0]);
  for (const m of text.matchAll(IPV4_RE)) if (!isPublicIp(m[0])) add('ip_address', 'IP address', m[0]);
  for (const m of text.matchAll(IPV6_RE)) {
    const ip = m[0];
    if (ip !== '::1' && /\d/.test(ip) && ip.split(':').filter(Boolean).length >= 2)
      add('ip_address', 'IP address', ip);
  }
  for (const re of INTERNAL_HOST_RE)
    for (const m of text.matchAll(re))
      if (!PUBLIC_HOSTS.has(m[0].toLowerCase())) add('internal_host', 'internal hostname', m[0]);
  return found;
}

/** Replaces every finding with `[REDACTED:<kind>]` (longest first, so a key inside a code block goes with the block). */
export function redactFindings(text: string, findings: GuardFinding[]): string {
  let out = text;
  for (const f of [...findings].sort((a, b) => b.match.length - a.match.length))
    out = out.split(f.match).join(`[REDACTED:${f.kind}]`);
  return out;
}

/** "private key, guard term (client)": what was found, never the matched text. */
export const findingLabels = (findings: GuardFinding[]) =>
  [...new Set(findings.map((f) => f.label))].join(', ');

/** POST /api/guard/check */
export const guardCheckRequestSchema = z.object({ text: z.string().max(1_000_000) });
export const guardCheckResponseSchema = z.object({
  findings: z.array(guardFindingSchema),
  redacted: z.string(),
});
export type GuardCheckResponse = z.infer<typeof guardCheckResponseSchema>;

export const guardTermViewSchema = z.object({
  id: z.string(),
  term: z.string(),
  kind: z.enum(GUARD_TERM_KINDS),
  note: z.string(),
  createdAt: z.string(),
});
export type GuardTermView = z.infer<typeof guardTermViewSchema>;

/** A one-line reason naming what was found, without repeating the matched text. */
export function describeFindings(findings: GuardFinding[], advice: string): string {
  return `Looks confidential (${findingLabels(findings)}). ${advice}`;
}
