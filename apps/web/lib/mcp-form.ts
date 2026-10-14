// The MCP server form (F35) as plain strings, and its conversion to and from the API's server shape.
import {
  type McpServerCreateInput,
  type McpServerView,
  type McpToolPolicy,
  type McpTransport,
  defaultDomains,
  mcpServerCreateSchema,
} from '@agenta/shared';

export type McpServerForm = {
  name: string;
  slug: string;
  description: string;
  transport: McpTransport;
  command: string;
  /** One argument per line. */
  args: string;
  cwd: string;
  url: string;
  /** `CHILD_VAR=ENV_LOCAL_NAME` per line. */
  env: string;
  /** `Header: template with ${NAME}` per line. */
  headers: string;
  /** Comma- or space-separated; empty = the defaults for the command / URL. */
  domains: string;
  defaultPolicy: McpToolPolicy;
};

export const emptyMcpForm: McpServerForm = {
  name: '',
  slug: '',
  description: '',
  transport: 'stdio',
  command: '',
  args: '',
  cwd: '',
  url: '',
  env: '',
  headers: '',
  domains: '',
  defaultPolicy: 'approval',
};

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function pairs(s: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines(s)) {
    const i = l.indexOf(sep);
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + sep.length).trim();
    else out[l] = '';
  }
  return out;
}

export function serverToForm(s: McpServerCreateInput | McpServerView): McpServerForm {
  return {
    name: s.name,
    slug: s.slug,
    description: s.description ?? '',
    transport: s.transport,
    command: s.command ?? '',
    args: (s.args ?? []).join('\n'),
    cwd: s.cwd ?? '',
    url: s.url ?? '',
    env: Object.entries(s.envRefs ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    headers: Object.entries(s.headerRefs ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    domains: (s.domains ?? []).join(', '),
    defaultPolicy: s.defaultPolicy ?? 'approval',
  };
}

/** Form → API input, validated with the shared schema. Errors are keyed by form field. */
export function formToServer(
  f: McpServerForm,
):
  | { ok: true; server: McpServerCreateInput }
  | { ok: false; errors: Partial<Record<keyof McpServerForm, string>> } {
  const stdio = f.transport === 'stdio';
  const server: McpServerCreateInput = {
    name: f.name.trim(),
    slug: f.slug.trim() || slugify(f.name),
    description: f.description.trim(),
    transport: f.transport,
    command: stdio ? f.command.trim() || null : null,
    args: stdio ? lines(f.args) : [],
    cwd: stdio ? f.cwd.trim() || null : null,
    url: stdio ? null : f.url.trim() || null,
    envRefs: stdio ? pairs(f.env, '=') : {},
    headerRefs: stdio ? {} : pairs(f.headers, ':'),
    domains: f.domains.split(/[\s,]+/).filter(Boolean),
    defaultPolicy: f.defaultPolicy,
  };
  const parsed = mcpServerCreateSchema.safeParse(server);
  if (parsed.success) return { ok: true, server };
  const errors: Partial<Record<keyof McpServerForm, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0] ?? 'name');
    const field =
      (
        { envRefs: 'env', headerRefs: 'headers', command: stdio ? 'command' : 'url' } as Record<
          string,
          string
        >
      )[key] ?? key;
    errors[field as keyof McpServerForm] ??= issue.message;
  }
  return { ok: false, errors };
}

/** What the domains field falls back to, shown as its placeholder. */
export const formDefaultDomains = (f: McpServerForm) =>
  defaultDomains({ transport: f.transport, command: f.command.trim(), url: f.url.trim() }).join(', ');

type Grant = { serverId: string; toolAllowlist: '*' | string[]; toolPolicies: Record<string, McpToolPolicy> };
type GrantInput = { serverId: string; tools: '*' | string[]; toolPolicies: Record<string, McpToolPolicy> };

/**
 * A bot's grants after one change on its page: a server on/off, every tool vs. an allowlist, or one tool on/off
 * (`allTools` = the server's tools, to expand `*` when one is unticked).
 */
export function changeGrants(
  grants: Grant[],
  change:
    | { serverId: string; on: boolean }
    | { serverId: string; tool: string; on: boolean; allTools: string[] }
    | { serverId: string; everyTool: boolean; allTools: string[] },
): GrantInput[] {
  const out: GrantInput[] = grants.map((g) => ({
    serverId: g.serverId,
    tools: g.toolAllowlist,
    toolPolicies: g.toolPolicies,
  }));
  const i = out.findIndex((g) => g.serverId === change.serverId);
  if ('everyTool' in change) {
    if (i >= 0) out[i] = { ...out[i]!, tools: change.everyTool ? '*' : [...change.allTools] };
    return out;
  }
  if (!('tool' in change)) {
    if (change.on && i < 0) out.push({ serverId: change.serverId, tools: '*', toolPolicies: {} });
    if (!change.on && i >= 0) out.splice(i, 1);
    return out;
  }
  if (i < 0) return out;
  const current = out[i]!.tools === '*' ? change.allTools : out[i]!.tools;
  const next = change.on ? [...new Set([...current, change.tool])] : current.filter((t) => t !== change.tool);
  out[i] = { ...out[i]!, tools: next };
  return out;
}
