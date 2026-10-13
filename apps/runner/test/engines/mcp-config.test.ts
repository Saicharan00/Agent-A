import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_MCP_SERVER, withManagedServers } from '../../src/engines/mcp-config';
import { writeMcpConfig } from '../../src/runs/prepare';

describe('MCP config (Playwright, F16)', () => {
  it('runs Playwright MCP headed with the persistent per-bot profile', () => {
    expect(PLAYWRIGHT_MCP_SERVER).toEqual({
      command: 'playwright-mcp',
      args: [
        '--config',
        '/opt/agenta/defaults/playwright-mcp.json',
        '--user-data-dir',
        '/home/bot/.browser-profile',
      ],
    });
  });

  it('adds Playwright and keeps the other servers', () => {
    expect(JSON.parse(withManagedServers(undefined))).toEqual({
      mcpServers: { playwright: PLAYWRIGHT_MCP_SERVER },
    });
    expect(JSON.parse(withManagedServers('not json'))).toEqual({
      mcpServers: { playwright: PLAYWRIGHT_MCP_SERVER },
    });
    const agenta = { type: 'http', url: 'http://host.docker.internal:3002/mcp' };
    const existing = JSON.stringify({ mcpServers: { agenta, playwright: { command: 'old' } } });
    expect(JSON.parse(withManagedServers(existing))).toEqual({
      mcpServers: { agenta, playwright: PLAYWRIGHT_MCP_SERVER },
    });
  });

  it('writes /home/bot/.agenta/mcp.json in the bot home', () => {
    const home = mkdtempSync(join(tmpdir(), 'agenta-mcp-'));
    writeMcpConfig(home);
    const path = join(home, '.agenta', 'mcp.json');
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.playwright).toEqual(PLAYWRIGHT_MCP_SERVER);
    mkdirSync(join(home, '.agenta'), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { x: { command: 'x' } } }));
    writeMcpConfig(home);
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).mcpServers)).toEqual(['x', 'playwright']);
  });

  it('adds the Platform MCP server with the bot token when the home has one (F17), private to the bot', () => {
    const home = mkdtempSync(join(tmpdir(), 'agenta-mcp-'));
    const url = 'http://host.docker.internal:3002/mcp';
    writeMcpConfig(home, url);
    const path = join(home, '.agenta', 'mcp.json');
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).mcpServers)).toEqual(['playwright']); // no token yet
    writeFileSync(join(home, '.agenta', 'mcp-token'), 'agm_abc\n');
    writeMcpConfig(home, url);
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.agenta).toEqual({
      type: 'http',
      url,
      headers: { Authorization: 'Bearer agm_abc' },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
