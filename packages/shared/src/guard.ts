// Secret detection (F22: memory saves). F24 grows this into the full confidentiality guard.

export type GuardFinding = { kind: string; label: string; match: string };

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

/** A one-line reason naming what was found, without repeating the secret. */
export function describeSecrets(findings: GuardFinding[]): string {
  const labels = [...new Set(findings.map((f) => f.label))];
  return `Looks like it contains a secret (${labels.join(', ')}). Memories must never hold secrets: remove it and save again.`;
}
