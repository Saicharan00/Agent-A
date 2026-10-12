import { CLAUDE_TOKEN_VAR } from '../../src/engines/claude-token';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** A fake Codex auth.json (ChatGPT login). `version` changes the tokens, as a refresh would. */
export function fakeCodexAuth(opts: { account?: string; plan?: string; version?: number } = {}): string {
  const account = opts.account ?? 'acct_1';
  const v = opts.version ?? 1;
  const idToken = `${b64({ alg: 'RS256' })}.${b64({
    'https://api.openai.com/auth': { chatgpt_plan_type: opts.plan ?? 'plus', chatgpt_account_id: account },
  })}.c2ln`;
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: `access-${v}`,
      refresh_token: `refresh-${v}`,
      account_id: account,
    },
    last_refresh: `2026-10-0${v}T00:00:00Z`,
  });
}

// Fake values are assembled at runtime so `pnpm check:secrets` doesn't flag test fixtures as real keys.
const sk = (...parts: string[]) => ['sk', ...parts].join('-');
export const FAKE_CLAUDE_TOKEN = sk('ant', 'oat01', 'FAKEtokenFORtests_0123456789abcdef');
export const FAKE_OTHER_CLAUDE_TOKEN = sk('ant', 'oat01', 'otherTOKENvalue');
export const FAKE_ANTHROPIC_API_KEY = sk('ant', 'api03', 'xxxxxxxxxxxx');

/** One dotenv line setting the Claude token variable. */
export const tokenLine = (value: string) => `${CLAUDE_TOKEN_VAR}=${value}\n`;
