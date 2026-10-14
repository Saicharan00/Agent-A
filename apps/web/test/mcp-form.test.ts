import { MCP_PRESETS } from '@agenta/shared';
import { describe, expect, it } from 'vitest';
import { changeGrants, emptyMcpForm, formDefaultDomains, formToServer, serverToForm } from '../lib/mcp-form';

describe('MCP server form (F35)', () => {
  it('turns the form into a server and back', () => {
    const r = formToServer({
      ...emptyMcpForm,
      name: 'My Notion',
      command: 'npx',
      args: '-y\n@notionhq/notion-mcp-server\n',
      env: 'NOTION_TOKEN=NOTION_TOKEN',
      domains: 'registry.npmjs.org, api.notion.com',
    });
    expect(r).toEqual({
      ok: true,
      server: {
        name: 'My Notion',
        slug: 'my-notion',
        description: '',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        cwd: null,
        url: null,
        envRefs: { NOTION_TOKEN: 'NOTION_TOKEN' },
        headerRefs: {},
        domains: ['registry.npmjs.org', 'api.notion.com'],
        defaultPolicy: 'approval',
      },
    });
    if (r.ok) expect(formToServer(serverToForm(r.server))).toEqual(r);
  });

  it('reports errors on the right fields, including pasted secrets', () => {
    const r = formToServer({
      ...emptyMcpForm,
      name: 'X',
      transport: 'http',
      headers: 'Authorization: Bearer abc',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.headers).toMatch(/never paste the secret/);
      expect(r.errors.url).toBeTruthy();
    }
    const s = formToServer({ ...emptyMcpForm, name: 'X', command: 'npx', args: 'ghp_abcdefghijklmnopqrst' });
    expect(!s.ok && s.errors.args).toMatch(/Looks like a secret/);
  });

  it('every preset round-trips through the form', () => {
    for (const p of MCP_PRESETS) expect(formToServer(serverToForm(p.server)).ok, p.id).toBe(true);
    expect(formDefaultDomains({ ...emptyMcpForm, transport: 'http', url: 'https://a.example.com/mcp' })).toBe(
      'a.example.com',
    );
  });

  it('changes a bot’s grants one click at a time', () => {
    const none = changeGrants([], { serverId: 's1', on: true });
    expect(none).toEqual([{ serverId: 's1', tools: '*', toolPolicies: {} }]);
    const grants = [{ serverId: 's1', toolAllowlist: '*' as const, toolPolicies: {} }];
    expect(changeGrants(grants, { serverId: 's1', tool: 'b', on: false, allTools: ['a', 'b'] })).toEqual([
      { serverId: 's1', tools: ['a'], toolPolicies: {} },
    ]);
    expect(
      changeGrants(grants, { serverId: 's1', everyTool: false, allTools: ['a', 'b'] })[0]!.tools,
    ).toEqual(['a', 'b']);
    expect(changeGrants(grants, { serverId: 's1', on: false })).toEqual([]);
  });
});
