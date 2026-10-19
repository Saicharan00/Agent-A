import { describe, expect, it } from 'vitest';
import {
  MCP_PRESETS,
  defaultDomains,
  looksLikeSecret,
  mcpServerCreateSchema,
  networkAllowCommand,
  parseMcpServersJson,
} from '../src/index';

describe('MCP presets & pasted JSON (F35)', () => {
  it('every preset is a valid server with unique ids and slugs, and lists the env vars it references', () => {
    expect(new Set(MCP_PRESETS.map((p) => p.id)).size).toBe(MCP_PRESETS.length);
    expect(new Set(MCP_PRESETS.map((p) => p.server.slug)).size).toBe(MCP_PRESETS.length);
    for (const p of MCP_PRESETS) {
      const s = mcpServerCreateSchema.parse(p.server);
      expect(s.domains.length, p.id).toBeGreaterThan(0);
      const refs = [
        ...Object.values(s.envRefs),
        ...[...Object.values(s.headerRefs), ...s.args].flatMap((t) =>
          [...t.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]),
        ),
      ];
      expect(p.env.map((e) => e.name).sort(), p.id).toEqual([...new Set(refs)].sort());
    }
  });

  it('moves literal secrets out of pasted mcpServers JSON into ${NAME} references', () => {
    const parsed = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          Notion: {
            command: 'npx',
            args: ['-y', '@notionhq/notion-mcp-server'],
            env: { NOTION_TOKEN: 'ntn_abc123def456' },
          },
          'my pg': { command: 'npx', args: ['-y', 'pg', 'postgresql://me:hunter22@db.example.com/app'] },
          linear: {
            url: 'https://mcp.linear.app/mcp',
            headers: { Authorization: 'Bearer lin_api_xyz12345' },
          },
          kept: { type: 'http', url: 'https://x.example.com/mcp', headers: { 'X-Key': '${X_KEY}' } },
          broken: { foo: 1 },
        },
      }),
    );
    expect(parsed.errors).toEqual(['broken: needs a "command" (stdio) or a "url" (http)']);
    const [notion, pg, linear, kept] = parsed.servers;
    expect(notion).toMatchObject({
      name: 'Notion',
      slug: 'notion',
      transport: 'stdio',
      envRefs: { NOTION_TOKEN: 'NOTION_TOKEN' },
      domains: ['registry.npmjs.org'],
    });
    expect(pg).toMatchObject({ slug: 'my-pg', args: ['-y', 'pg', '${MY_PG_ARG_3}'] });
    expect(linear).toMatchObject({
      transport: 'http',
      headerRefs: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
      domains: ['mcp.linear.app'],
    });
    expect(kept).toMatchObject({ headerRefs: { 'X-Key': '${X_KEY}' } });
    expect(parsed.moved).toEqual([
      { variable: 'NOTION_TOKEN', server: 'Notion', where: 'env NOTION_TOKEN' },
      { variable: 'MY_PG_ARG_3', server: 'my pg', where: 'argument 3' },
      { variable: 'LINEAR_TOKEN', server: 'linear', where: 'header Authorization' },
    ]);
    const json = JSON.stringify(parsed);
    for (const secret of ['ntn_abc123def456', 'hunter22', 'lin_api_xyz12345'])
      expect(json).not.toContain(secret);
    for (const s of parsed.servers) expect(mcpServerCreateSchema.safeParse(s).success, s.slug).toBe(true);
  });

  it('reports invalid JSON and the wrong shape', () => {
    expect(parseMcpServersJson('{').errors[0]).toMatch(/Not valid JSON/);
    expect(parseMcpServersJson('[]').errors).toEqual(['Expected { "mcpServers": { "<name>": { … } } }']);
  });

  it('secret detection and domains', () => {
    for (const s of [
      'sk-ant-abcdefgh123',
      'ghp_abcdefghijklmnop',
      'postgres://u:p@h/db',
      'AbC123dEf456GhI789jKl012MnO345pQr',
    ])
      expect(looksLikeSecret(s), s).toBe(true);
    for (const s of [
      '-y',
      '@notionhq/notion-mcp-server',
      '--db-path',
      '/home/bot/work/db.sqlite',
      '${TOKEN}',
      'https://a.b/c',
    ])
      expect(looksLikeSecret(s), s).toBe(false);
    expect(defaultDomains({ transport: 'stdio', command: '/usr/bin/uvx' })).toEqual([
      'pypi.org',
      'files.pythonhosted.org',
    ]);
    expect(defaultDomains({ transport: 'stdio', command: 'node' })).toEqual([]);
    expect(networkAllowCommand([], 'box')).toBeNull();
    expect(networkAllowCommand(['a.com'], null)).toBeNull();
    expect(networkAllowCommand(['a.com', 'b.com'], 'box')).toBe(
      'sbx policy allow network --sandbox box a.com,b.com',
    );
  });
});
