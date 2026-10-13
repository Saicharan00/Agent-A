import { PLATFORM_MCP_SERVER } from '@agenta/shared';
import { CONTAINER_HOME } from './process';

/** Each bot's persistent Chromium profile: sign-ins made by the bot (or the owner on the desktop) survive runs. */
export const BROWSER_PROFILE_DIR = `${CONTAINER_HOME}/.browser-profile`;

/**
 * Playwright MCP for both engines: headed Chromium on the bot's desktop (the exec env sets DISPLAY=:99), so the owner
 * can watch in the Desktop tab. Flags observed in docs/engines.md; `--user-data-dir` overrides the image config's.
 */
export const PLAYWRIGHT_MCP_SERVER = {
  command: 'playwright-mcp',
  args: ['--config', '/opt/agenta/defaults/playwright-mcp.json', '--user-data-dir', BROWSER_PROFILE_DIR],
};

/** The Platform MCP server (F17) as bots reach it, authenticated with the bot's own token. */
export function platformMcpServer(url: string, token: string) {
  return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
}

/**
 * The Claude MCP config (/home/bot/.agenta/mcp.json) with the servers the runner manages set: Playwright always, the
 * Platform MCP server when given. Other servers (F35) are kept.
 */
export function withManagedServers(
  existing: string | undefined,
  platform?: { url: string; token: string },
): string {
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    const parsed = existing ? (JSON.parse(existing) as unknown) : {};
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) config = parsed;
  } catch {
    // unreadable: start over
  }
  const servers =
    typeof config.mcpServers === 'object' && config.mcpServers !== null && !Array.isArray(config.mcpServers)
      ? config.mcpServers
      : {};
  const managed = {
    ...(platform ? { [PLATFORM_MCP_SERVER]: platformMcpServer(platform.url, platform.token) } : {}),
    playwright: PLAYWRIGHT_MCP_SERVER,
  };
  return `${JSON.stringify({ ...config, mcpServers: { ...servers, ...managed } }, null, 2)}\n`;
}
