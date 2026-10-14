// MCP gateway helpers shared by the runner and the web app (PLAN F35 session 2): presets, the pasted `mcpServers`
// JSON parser, secret detection and the domains a server needs in the sandbox network policy.
// Type-only imports from ./mcp-gateway (it imports this file at runtime).
import type { McpServerCreateInput } from './mcp-gateway';

/** `${NAME}` references to .env.local variables in args and header templates. */
export const VAR_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export const templateVars = (s: string): string[] => [...s.matchAll(VAR_REF_RE)].map((m) => m[1]!);

/**
 * True for values that look like credentials: known token prefixes, a password inside a URL, a JWT, or a long
 * random-looking string. `${NAME}` references never count.
 */
export function looksLikeSecret(value: string): boolean {
  const v = value.replace(VAR_REF_RE, '').trim();
  if (!v) return false;
  if (
    /(sk-|sk_live_|sk_test_|ghp_|gho_|github_pat_|xox[abpr]-|ntn_|secret_|lin_api_|glpat-|AKIA)[A-Za-z0-9_-]{6,}/.test(
      v,
    )
  )
    return true;
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v)) return true; // user:password@host
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./.test(v)) return true;
  // A long token-shaped run (no spaces, mixes letters and digits): API keys, but not paths or URLs.
  return (
    /^(--?[a-z-]+=)?[A-Za-z0-9_\-+/=]{32,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !v.includes('/')
  );
}

/** The domains a server reaches, by default: its URL's host, or the package registry its launcher downloads from. */
export function defaultDomains(s: {
  transport: string;
  command?: string | null;
  url?: string | null;
}): string[] {
  if (s.transport === 'http' && s.url) {
    try {
      return [new URL(s.url).hostname];
    } catch {
      return [];
    }
  }
  const cmd = (s.command ?? '').split('/').pop() ?? '';
  if (cmd === 'npx' || cmd === 'npm' || cmd === 'pnpm') return ['registry.npmjs.org'];
  if (cmd === 'uvx' || cmd === 'uv' || cmd === 'pip' || cmd === 'pipx')
    return ['pypi.org', 'files.pythonhosted.org'];
  return [];
}

/** The owner's host-side command to allow `domains` for this sandbox. */
export function networkAllowCommand(domains: string[], sandbox = 'agent-a'): string | null {
  return domains.length ? `sbx policy allow network --sandbox ${sandbox} ${domains.join(',')}` : null;
}

export type McpPreset = {
  id: string;
  name: string;
  description: string;
  server: McpServerCreateInput;
  /** .env.local variables to set first, with where to get them. */
  env: { name: string; help: string; optional?: boolean }[];
  /** Granted to every specialist when added (the team's defaults, F21). */
  teamDefault?: boolean;
  note?: string;
};

const npx = (pkg: string, ...args: string[]) => ({
  transport: 'stdio' as const,
  command: 'npx',
  args: ['-y', pkg, ...args],
});
// `uvx` is not installed in the sandbox VM; `uv tool run` is the same thing (DECISIONS F35).
const uvx = (pkg: string, ...args: string[]) => ({
  transport: 'stdio' as const,
  command: 'uv',
  args: ['tool', 'run', pkg, ...args],
});

/** Templates only: nothing is added or enabled until the owner adds one. */
export const MCP_PRESETS: McpPreset[] = [
  {
    id: 'fetch',
    name: 'Web fetch',
    description: 'Fetches a web page and returns it as markdown, for research.',
    server: {
      name: 'Web fetch',
      slug: 'fetch',
      description: 'Fetch a web page as markdown (research; cite the URL).',
      ...uvx('mcp-server-fetch'),
      domains: ['pypi.org', 'files.pythonhosted.org'],
      defaultPolicy: 'allow',
    },
    env: [],
    teamDefault: true,
    note: 'Pages it fetches need their domains allowed too (see Web research below).',
  },
  {
    id: 'context7',
    name: 'Library & API docs (Context7)',
    description: 'Up-to-date documentation and code examples for libraries and APIs.',
    server: {
      name: 'Context7 docs',
      slug: 'context7',
      description: 'Look up current library and API documentation (resolve the library id first).',
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      domains: ['mcp.context7.com'],
      defaultPolicy: 'allow',
    },
    env: [],
    teamDefault: true,
    note: 'Works without a key (rate limited). With a key: add the header Authorization = Bearer ${CONTEXT7_API_KEY}.',
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential thinking',
    description: 'A scratchpad tool for step-by-step problem solving.',
    server: {
      name: 'Sequential thinking',
      slug: 'thinking',
      description: 'Think through hard problems step by step.',
      ...npx('@modelcontextprotocol/server-sequential-thinking'),
      domains: ['registry.npmjs.org'],
      defaultPolicy: 'allow',
    },
    env: [],
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search, read and edit pages and databases in a Notion workspace.',
    server: {
      name: 'Notion',
      slug: 'notion',
      description: 'Search and read Notion pages and databases; edits need approval.',
      ...npx('@notionhq/notion-mcp-server'),
      envRefs: { NOTION_TOKEN: 'NOTION_TOKEN' },
      domains: ['registry.npmjs.org', 'api.notion.com'],
    },
    env: [
      {
        name: 'NOTION_TOKEN',
        help: 'notion.so/profile/integrations → new internal integration → token; share pages with it.',
      },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels and post messages in a Slack workspace.',
    server: {
      name: 'Slack',
      slug: 'slack',
      description: 'Read Slack channels and threads; posting needs approval.',
      ...npx('@modelcontextprotocol/server-slack'),
      envRefs: { SLACK_BOT_TOKEN: 'SLACK_BOT_TOKEN', SLACK_TEAM_ID: 'SLACK_TEAM_ID' },
      domains: ['registry.npmjs.org', 'slack.com'],
    },
    env: [
      {
        name: 'SLACK_BOT_TOKEN',
        help: 'api.slack.com/apps → your app → OAuth & Permissions → Bot token (xoxb-…).',
      },
      { name: 'SLACK_TEAM_ID', help: 'Your workspace id (starts with T).' },
    ],
  },
  {
    id: 'postgres',
    name: 'Postgres (read-only)',
    description: 'Inspect schemas and run read-only SQL against a Postgres database.',
    server: {
      name: 'Postgres',
      slug: 'postgres',
      description: 'Read-only SQL and schema inspection on the project database.',
      ...npx('@modelcontextprotocol/server-postgres', '${POSTGRES_URL}'),
      domains: ['registry.npmjs.org'],
    },
    env: [
      {
        name: 'POSTGRES_URL',
        help: 'postgresql://user:password@host:5432/db (add its host to the domains).',
      },
    ],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and change a local SQLite database file.',
    server: {
      name: 'SQLite',
      slug: 'sqlite',
      description: 'Query a local SQLite database; writes need approval.',
      ...uvx('mcp-server-sqlite', '--db-path', '/path/to/database.db'),
      domains: ['pypi.org', 'files.pythonhosted.org'],
    },
    env: [],
    note: 'Change --db-path to the database file (a path inside the sandbox VM).',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Find, create and update Linear issues and projects.',
    server: {
      name: 'Linear',
      slug: 'linear',
      description: 'Read Linear issues and projects; creating or changing them needs approval.',
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      headerRefs: { Authorization: 'Bearer ${LINEAR_API_KEY}' },
      domains: ['mcp.linear.app'],
    },
    env: [{ name: 'LINEAR_API_KEY', help: 'linear.app → Settings → Security & access → Personal API keys.' }],
  },
  {
    id: 'jira',
    name: 'Jira & Confluence',
    description: 'Search and update Jira issues and Confluence pages (Atlassian Cloud).',
    server: {
      name: 'Atlassian',
      slug: 'atlassian',
      description: 'Read Jira issues and Confluence pages; changes need approval.',
      ...uvx('mcp-atlassian'),
      envRefs: {
        JIRA_URL: 'JIRA_URL',
        JIRA_USERNAME: 'JIRA_USERNAME',
        JIRA_API_TOKEN: 'JIRA_API_TOKEN',
      },
      domains: ['pypi.org', 'files.pythonhosted.org'],
    },
    env: [
      {
        name: 'JIRA_URL',
        help: 'https://your-site.atlassian.net (add your-site.atlassian.net to the domains).',
      },
      { name: 'JIRA_USERNAME', help: 'Your Atlassian account email.' },
      { name: 'JIRA_API_TOKEN', help: 'id.atlassian.com/manage-profile/security/api-tokens.' },
    ],
  },
  {
    id: 'gdrive',
    name: 'Google Drive',
    description: 'Search and read files in Google Drive.',
    server: {
      name: 'Google Drive',
      slug: 'gdrive',
      description: 'Search and read Google Drive files.',
      ...npx('@modelcontextprotocol/server-gdrive'),
      envRefs: { GDRIVE_CREDENTIALS_PATH: 'GDRIVE_CREDENTIALS_PATH' },
      domains: ['registry.npmjs.org', 'www.googleapis.com', 'oauth2.googleapis.com'],
    },
    env: [
      {
        name: 'GDRIVE_CREDENTIALS_PATH',
        help: 'Path (in the sandbox VM) to the credentials file the package creates with its one-time `auth` step.',
      },
    ],
    note: 'Needs a Google Cloud OAuth client and a one-time `npx @modelcontextprotocol/server-gdrive auth` in the VM.',
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read Figma files and frames for design-to-code work.',
    server: {
      name: 'Figma',
      slug: 'figma',
      description: 'Read Figma designs (layout, styles, frames).',
      ...npx('figma-developer-mcp', '--stdio'),
      envRefs: { FIGMA_API_KEY: 'FIGMA_API_KEY' },
      domains: ['registry.npmjs.org', 'api.figma.com'],
      defaultPolicy: 'allow',
    },
    env: [{ name: 'FIGMA_API_KEY', help: 'figma.com → Settings → Security → Personal access tokens.' }],
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Look up Sentry issues, events and releases.',
    server: {
      name: 'Sentry',
      slug: 'sentry',
      description: 'Investigate Sentry issues and stack traces.',
      ...npx('@sentry/mcp-server', '--access-token=${SENTRY_ACCESS_TOKEN}'),
      domains: ['registry.npmjs.org', 'sentry.io'],
    },
    env: [{ name: 'SENTRY_ACCESS_TOKEN', help: 'sentry.io → Settings → Account → API → Personal tokens.' }],
  },
];

/** A literal secret found in pasted JSON: moved out to a .env.local variable. */
export type MovedSecret = { variable: string; server: string; where: string };
export type ParsedMcpJson = { servers: McpServerCreateInput[]; moved: MovedSecret[]; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const toSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'server';
const varName = (...parts: string[]) =>
  parts
    .join('_')
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^(\d)/, '_$1');

/**
 * Parses the common `mcpServers` config (Claude Desktop / Claude Code / Cursor) into servers to create. Values are
 * never kept: every env value, every header value and any secret-looking argument becomes a `${NAME}` reference, and
 * `moved` lists the variables the owner must put in .env.local. Already-referenced `${NAME}` values are kept.
 */
export function parseMcpServersJson(text: string): ParsedMcpJson {
  const out: ParsedMcpJson = { servers: [], moved: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    out.errors.push(`Not valid JSON: ${(err as Error).message}`);
    return out;
  }
  const root = isObj(parsed) && isObj(parsed.mcpServers) ? parsed.mcpServers : isObj(parsed) ? parsed : null;
  if (!root || !Object.keys(root).length) {
    out.errors.push('Expected { "mcpServers": { "<name>": { … } } }');
    return out;
  }
  for (const [key, raw] of Object.entries(root)) {
    if (!isObj(raw)) {
      out.errors.push(`${key}: not an object`);
      continue;
    }
    const slug = toSlug(key);
    const moved = (variable: string, where: string) => out.moved.push({ variable, server: key, where });
    const url =
      typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : null;
    const command = typeof raw.command === 'string' ? raw.command : null;
    if (!url && !command) {
      out.errors.push(`${key}: needs a "command" (stdio) or a "url" (http)`);
      continue;
    }
    const server: McpServerCreateInput = { name: key, slug, transport: url ? 'http' : 'stdio' };
    if (url) {
      server.url = url;
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(isObj(raw.headers) ? raw.headers : {})) {
        const value = String(v);
        if (templateVars(value).length) headers[h] = value;
        else {
          const variable = varName(slug, h === 'Authorization' ? 'TOKEN' : h);
          const scheme = /^(Bearer|Basic|Token)\s+/i.exec(value)?.[0] ?? '';
          headers[h] = `${scheme}\${${variable}}`;
          moved(variable, `header ${h}`);
        }
      }
      server.headerRefs = headers;
    } else {
      server.command = command;
      server.args = (Array.isArray(raw.args) ? raw.args : []).map((a, i) => {
        const value = String(a);
        if (!looksLikeSecret(value)) return value;
        const variable = varName(slug, 'ARG', String(i + 1));
        moved(variable, `argument ${i + 1}`);
        const flag = /^(--?[a-z-]+=)/i.exec(value)?.[1] ?? '';
        return `${flag}\${${variable}}`;
      });
      if (typeof raw.cwd === 'string') server.cwd = raw.cwd;
      const envRefs: Record<string, string> = {};
      for (const [k, v] of Object.entries(isObj(raw.env) ? raw.env : {})) {
        const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(String(v))?.[1];
        envRefs[k] = ref ?? k;
        if (!ref) moved(k, `env ${k}`);
      }
      server.envRefs = envRefs;
    }
    server.domains = defaultDomains({
      transport: server.transport,
      command: server.command,
      url: server.url,
    });
    out.servers.push(server);
  }
  return out;
}
