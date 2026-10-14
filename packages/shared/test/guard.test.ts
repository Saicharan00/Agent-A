import { describe, expect, it } from 'vitest';
import {
  GUARD_CODE_LINES,
  checkConfidential,
  describeFindings,
  findSecrets,
  redactFindings,
} from '../src/guard';

const kinds = (t: string) => findSecrets(t).map((f) => f.kind);

describe('findSecrets', () => {
  it.each([
    ['Anthropic key', 'key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345'],
    ['OpenAI key', 'OPENAI sk-proj-abcdefghijklmnopqrstuvwx1234'],
    ['GitHub token', 'ghp_0123456789abcdefghijABCDEFGHIJ012345'],
    ['AWS key', 'AKIAIOSFODNN7EXAMPLE'],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['assignment', 'password = hunter2hunter2'],
    ['high entropy', 'token Zq8vR2xK9mWp4LtY7nBc3HdF6gJs1QeA0uVo'],
  ])('flags %s', (_, text) => {
    expect(findSecrets(text).length).toBeGreaterThan(0);
  });

  it.each([
    ['prose', 'Use pnpm, never npm. Deploy from the staging branch first.'],
    ['git sha', 'Fixed in 3f786850e387550fdab836ed7e6dc881de23001b'],
    ['uuid', 'run 123e4567-e89b-12d3-a456-426614174000'],
    ['path', '/home/bot/work/apps/web/components/settings/team-section.tsx'],
    ['word "token"', 'The token budget is small.'],
  ])('ignores %s', (_, text) => {
    expect(findSecrets(text)).toEqual([]);
  });

  it('reports one finding per secret and never repeats it in the reason', () => {
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    expect(kinds(`${key} and ${key}`)).toEqual(['api_key']);
    const reason = describeFindings(findSecrets(key), 'Remove it.');
    expect(reason).toContain('Anthropic API key');
    expect(reason).not.toContain(key);
  });
});

describe('checkConfidential', () => {
  const kindsOf = (t: string, terms = []) => checkConfidential(t, terms).map((f) => f.kind);
  const code = (n: number) => Array.from({ length: n }, (_, i) => `  const v${i} = f(${i});`).join('\n');

  it.each([
    ['email', 'Mail jane.doe@acme-corp.com about it', 'email'],
    ['private IPv4', 'the db is at 10.20.30.40:5432', 'ip_address'],
    ['public IPv4', 'ping 8.8.8.8', 'ip_address'],
    ['IPv6', 'host fe80::1ff:fe23:4567:890a here', 'ip_address'],
    ['.internal host', 'https://billing.prod.internal/api', 'internal_host'],
    ['.corp host', 'ssh build01.corp', 'internal_host'],
    ['intranet URL', 'see https://intranet.acme.com/wiki', 'internal_host'],
    ['SharePoint', 'acme.sharepoint.com/sites/x', 'internal_host'],
    ['fenced code block', '```ts\n' + code(GUARD_CODE_LINES + 1) + '\n```', 'code_block'],
    ['unfenced code paste', code(GUARD_CODE_LINES + 1), 'code_block'],
  ])('flags %s', (_, text, kind) => {
    expect(kindsOf(text)).toContain(kind);
  });

  it.each([
    ['loopback', 'bind to 127.0.0.1 and 0.0.0.0'],
    ['::1', 'listen on ::1'],
    ['docker host', 'curl http://host.docker.internal:3001'],
    ['.env.local', 'put it in .env.local'],
    ['version', 'upgrade to v1.2.3'],
    ['time', 'at 12:30:45'],
    ['C++ scope', 'std::vector and Foo::bar'],
    ['npm scope / mention', 'import from @agenta/shared, ask @agent-a'],
    ['git remote', 'git@github.com:owner/repo.git'],
    ['short code block', '```ts\n' + code(GUARD_CODE_LINES - 1) + '\n```'],
    [
      'long prose',
      Array.from({ length: GUARD_CODE_LINES + 10 }, () => 'A plain sentence about the plan').join('\n'),
    ],
  ])('ignores %s', (_, text) => {
    expect(kindsOf(text)).toEqual([]);
  });

  it('matches literal guard terms case-insensitively and regex terms', () => {
    const terms = [
      { term: 'Acme', kind: 'literal' as const, note: 'company' },
      { term: 'project-(falcon|hawk)', kind: 'regex' as const },
      { term: 'a.b', kind: 'literal' as const },
    ];
    const f = checkConfidential('ACME ships project-hawk; axb is fine', terms);
    expect(f.map((x) => [x.kind, x.match])).toEqual([
      ['guard_term', 'ACME'],
      ['guard_term', 'project-hawk'],
    ]);
    expect(f[0]!.label).toBe('guard term (company)');
    expect(checkConfidential('nothing here', terms)).toEqual([]);
  });

  it('skips broken and empty-matching regex terms', () => {
    expect(
      checkConfidential('abc', [
        { term: '(', kind: 'regex' },
        { term: 'x*', kind: 'regex' },
      ]),
    ).toEqual([]);
  });

  it('redacts every occurrence with its kind', () => {
    const text = 'Acme: mail bob@acme.io, Acme again';
    const f = checkConfidential(text, [{ term: 'Acme', kind: 'literal' }]);
    expect(redactFindings(text, f)).toBe(
      '[REDACTED:guard_term]: mail [REDACTED:email], [REDACTED:guard_term] again',
    );
  });
});
