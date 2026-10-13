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

/** The Claude MCP config (/home/bot/.agenta/mcp.json) with Playwright set; other servers (F17, F35) are kept. */
export function withPlaywrightServer(existing: string | undefined): string {
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
  return `${JSON.stringify({ ...config, mcpServers: { ...servers, playwright: PLAYWRIGHT_MCP_SERVER } }, null, 2)}\n`;
}
