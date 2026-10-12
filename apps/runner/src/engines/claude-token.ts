// Dependency-free so scripts/engine-login.ts can import it.

export const CLAUDE_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/** Null when the value looks like a `claude setup-token` token; otherwise a secret-free explanation. */
export function claudeTokenProblem(token: string): string | null {
  if (/\s/.test(token))
    return `${CLAUDE_TOKEN_VAR} contains spaces or line breaks; paste the token on one line.`;
  if (token.startsWith('sk-ant-api')) {
    return `${CLAUDE_TOKEN_VAR} holds an Anthropic API key, not a subscription token. Run \`claude setup-token\` instead.`;
  }
  if (!token.startsWith('sk-ant-')) {
    return `${CLAUDE_TOKEN_VAR} does not look like a token from \`claude setup-token\` (expected sk-ant-…).`;
  }
  return null;
}
