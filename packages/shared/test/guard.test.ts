import { describe, expect, it } from 'vitest';
import { describeSecrets, findSecrets } from '../src/guard';

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
    const reason = describeSecrets(findSecrets(key));
    expect(reason).toContain('Anthropic API key');
    expect(reason).not.toContain(key);
  });
});
