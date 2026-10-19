'use client';

import {
  MCP_PRESETS,
  MCP_TOOL_POLICIES,
  type McpPreset,
  type McpServerView,
  type McpToolPolicy,
  type ParsedMcpJson,
  type ResearchSettings,
  type WebAccessMode,
  parseMcpServersJson,
} from '@agenta/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { StatusPill } from '@/components/status-pill';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea, invalidProps } from '@/components/ui/form';
import { mcpApi } from '@/lib/mcp';
import {
  type McpServerForm,
  emptyMcpForm,
  formDefaultDomains,
  formToServer,
  serverToForm,
  slugify,
} from '@/lib/mcp-form';
import { queryKeys } from '@/lib/query-keys';
import { toast } from '@/lib/toast';

const STATE_TONE = { connected: 'ok', idle: 'neutral', error: 'error' } as const;

function Command({ children, label }: { children: string; label: string }) {
  return (
    <div className="flex items-start gap-2">
      <code
        className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-all"
        aria-label={label}
      >
        {children}
      </code>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void navigator.clipboard?.writeText(children).then(() => toast.success('Copied'))}
      >
        Copy
      </Button>
    </div>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: queryKeys.mcpServers });
    void qc.invalidateQueries({ queryKey: ['bots', 'mcp-access'] });
  };
}

/** Web research (F35): per-domain allowing (safer) or one broad allowance; the owner's sbx command. */
function ResearchCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: queryKeys.research, queryFn: mcpApi.research });
  const save = useMutation({
    mutationFn: (mode: WebAccessMode) => mcpApi.setResearch(mode),
    onMutate: async (mode) => {
      await qc.cancelQueries({ queryKey: queryKeys.research });
      qc.setQueryData<ResearchSettings>(queryKeys.research, (old) => old && { ...old, webAccess: mode });
    },
    onSuccess: (fresh) => {
      qc.setQueryData(queryKeys.research, fresh);
      toast.success(fresh.command ? 'Saved. The matching command was added to HUMAN_TODO.md.' : 'Saved.');
    },
    onError: (err) => {
      toast.error(`Could not save: ${err.message}`);
      void qc.invalidateQueries({ queryKey: queryKeys.research });
    },
  });
  const options: { mode: WebAccessMode; label: string; hint: string }[] = [
    {
      mode: 'per-domain',
      label: 'Allow domains one by one (safer)',
      hint: 'Bots tell you which domain a blocked page needs; you allow just that one. More prompts.',
    },
    {
      mode: 'broad',
      label: 'Broad web allowance for research',
      hint: 'One command lets every bot computer reach any website. Fewer prompts, less control.',
    },
  ];
  return (
    <article className="flex flex-col gap-3 rounded-lg border p-4" aria-label="Web research">
      <h2 className="font-medium">Web research</h2>
      <p className="text-sm text-muted-foreground">
        Every bot can use its engine&apos;s built-in web search (Claude Code web search and fetch, Codex live
        search) and is told to cite its sources. In a Docker Sandbox, pages a bot fetches or browses from its
        computer must be allowed by the sandbox network policy.
      </p>
      <fieldset className="flex flex-col gap-2" disabled={!data}>
        <legend className="sr-only">How pages get through the network policy</legend>
        {options.map((o) => (
          <label key={o.mode} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="web-access"
              className="mt-1"
              checked={data?.webAccess === o.mode}
              onChange={() => save.mutate(o.mode)}
            />
            <span>
              <span className="font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {data?.command && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Run on your host:</p>
          <Command label="Web access command">{data.command}</Command>
        </div>
      )}
    </article>
  );
}

function ToolsTable({ server }: { server: McpServerView }) {
  const invalidate = useInvalidate();
  const setPolicy = useMutation({
    mutationFn: (p: { tool: string; policy: McpToolPolicy }) =>
      mcpApi.update(server.id, { toolPolicies: { ...server.toolPolicies, [p.tool]: p.policy } }),
    onSuccess: invalidate,
    onError: (err) => toast.error(`Could not save: ${err.message}`),
  });
  if (!server.tools.length)
    return <p className="text-sm text-muted-foreground">No tools listed yet. Press “Test connection”.</p>;
  return (
    <table className="w-full text-sm" aria-label={`${server.name} tools`}>
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1 font-medium">Tool</th>
          <th className="py-1 font-medium">What it does</th>
          <th className="w-32 py-1 font-medium">Policy</th>
        </tr>
      </thead>
      <tbody>
        {server.tools.map((t) => (
          <tr key={t.name} className="border-t align-top" data-testid={`tool-${t.name}`}>
            <td className="py-1.5 pr-2 font-mono text-xs">{t.name}</td>
            <td className="py-1.5 pr-2 text-xs text-muted-foreground">{t.description ?? '—'}</td>
            <td className="py-1.5">
              <Select
                aria-label={`Policy for ${t.name}`}
                value={t.policy}
                disabled={setPolicy.isPending}
                onChange={(e) => setPolicy.mutate({ tool: t.name, policy: e.target.value as McpToolPolicy })}
                className="h-8"
              >
                {MCP_TOOL_POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {p === 'approval' ? 'needs approval' : p}
                  </option>
                ))}
              </Select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServerCard({ server, onEdit }: { server: McpServerView; onEdit: () => void }) {
  const invalidate = useInvalidate();
  const test = useMutation({
    mutationFn: () => mcpApi.test(server.id),
    onSuccess: (s) => {
      invalidate();
      if (s.lastError) toast.error(`${s.name}: connection failed`);
      else toast.success(`${s.name}: ${s.tools.length} tools`);
    },
    onError: (err) => toast.error(`Test failed: ${err.message}`),
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => mcpApi.update(server.id, { enabled }),
    onSuccess: invalidate,
    onError: (err) => toast.error(`Could not save: ${err.message}`),
  });
  const signIn = useMutation({
    mutationFn: () => mcpApi.oauthStart(server.id),
    onSuccess: (r) => {
      // The server's sign-in page sends the browser back to /settings/mcp (via /api/mcp-oauth/callback).
      if (r.authorizationUrl) window.location.assign(r.authorizationUrl);
      else {
        invalidate();
        toast.success(`${server.name}: already signed in`);
      }
    },
    onError: (err) => toast.error(err.message),
  });
  const signOut = useMutation({
    mutationFn: () => mcpApi.oauthSignOut(server.id),
    onSuccess: invalidate,
    onError: (err) => toast.error(`Could not sign out: ${err.message}`),
  });
  const needsSignIn = server.transport === 'http' && /OAuth sign-in/.test(server.lastError ?? '');
  const remove = useMutation({
    mutationFn: () => mcpApi.remove(server.id),
    onSuccess: invalidate,
    onError: (err) => toast.error(`Could not remove: ${err.message}`),
  });
  return (
    <article
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={`MCP server ${server.name}`}
      data-testid={`mcp-server-${server.slug}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium">
            {server.name} <span className="font-mono text-xs text-muted-foreground">{server.slug}</span>
          </h3>
          {server.description && <p className="text-sm text-muted-foreground">{server.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          {server.oauth === 'signed-in' && <StatusPill tone="ok">signed in</StatusPill>}
          <StatusPill tone={server.enabled ? STATE_TONE[server.state] : 'neutral'} data-testid="mcp-state">
            {server.enabled ? server.state : 'disabled'}
          </StatusPill>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={server.enabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
            Enabled
          </label>
        </div>
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">
        {server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}
      </p>
      {server.missingSecrets.length > 0 && (
        <p className="text-sm text-warning" role="status">
          Set {server.missingSecrets.map((n) => `${n}=…`).join(', ')} in .env.local (never paste secrets
          here).
        </p>
      )}
      {server.networkCommand && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            Allow its domains ({server.domains.join(', ')}) on your host, once (also in HUMAN_TODO.md):
          </p>
          <Command label={`Network command for ${server.name}`}>{server.networkCommand}</Command>
        </div>
      )}
      {server.lastError && (
        <pre
          className="max-h-40 overflow-auto rounded bg-destructive/10 p-2 text-xs whitespace-pre-wrap text-destructive"
          data-testid="mcp-error"
        >
          {server.lastError}
        </pre>
      )}
      <ToolsTable server={server} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        {(needsSignIn || server.oauth === 'signed-in') &&
          (server.oauth === 'signed-in' ? (
            <Button size="sm" variant="outline" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              Sign out
            </Button>
          ) : (
            <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
              Sign in
            </Button>
          ))}
        <Button size="sm" variant="outline" onClick={onEdit}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Remove ${server.name}? Bots lose its tools.`)) remove.mutate();
          }}
        >
          Remove
        </Button>
        <span className="text-xs text-muted-foreground">
          {server.botIds.length} bot{server.botIds.length === 1 ? '' : 's'} may use it (set per bot on its
          page)
        </span>
      </div>
    </article>
  );
}

function ServerFormPanel({
  initial,
  editing,
  grantDefault,
  onDone,
}: {
  initial: McpServerForm;
  editing?: McpServerView;
  grantDefault?: boolean;
  onDone: () => void;
}) {
  const invalidate = useInvalidate();
  const [form, setForm] = useState(initial);
  const [grant, setGrant] = useState(!!grantDefault);
  const [errors, setErrors] = useState<Partial<Record<keyof McpServerForm, string>>>({});
  const set = (k: keyof McpServerForm) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: async () => {
      const r = formToServer(form);
      if (!r.ok) {
        setErrors(r.errors);
        return null;
      }
      setErrors({});
      return editing
        ? mcpApi.update(editing.id, r.server)
        : mcpApi.create(r.server, grant ? 'specialists' : undefined);
    },
    onSuccess: (s) => {
      if (!s) return;
      invalidate();
      toast.success(
        `${editing ? 'Saved' : 'Added'} ${s.name}${s.networkCommand ? '. Allow its domains (see the card).' : ''}`,
      );
      onDone();
    },
    onError: (err) => toast.error(`Could not save: ${err.message}`),
  });
  const id = (k: string) => `mcp-${k}`;
  const stdio = form.transport === 'stdio';
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      aria-label={editing ? `Edit ${editing.name}` : 'Add MCP server'}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name" htmlFor={id('name')} error={errors.name}>
        <Input
          id={id('name')}
          value={form.name}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              name: e.target.value,
              slug: editing || f.slug !== slugify(f.name) ? f.slug : slugify(e.target.value),
            }))
          }
          {...invalidProps(id('name'), errors.name)}
        />
      </Field>
      <Field label="Slug" htmlFor={id('slug')} error={errors.slug} hint="Tools are named <slug>__<tool>.">
        <Input
          id={id('slug')}
          value={form.slug}
          onChange={set('slug')}
          {...invalidProps(id('slug'), errors.slug)}
        />
      </Field>
      <Field
        label="What it is for"
        htmlFor={id('description')}
        className="sm:col-span-2"
        hint="Shown to granted bots."
      >
        <Input id={id('description')} value={form.description} onChange={set('description')} />
      </Field>
      <Field label="Transport" htmlFor={id('transport')}>
        <Select id={id('transport')} value={form.transport} onChange={set('transport')}>
          <option value="stdio">stdio (a command run in the sandbox)</option>
          <option value="http">http (a remote URL)</option>
        </Select>
      </Field>
      <Field
        label="Default policy"
        htmlFor={id('policy')}
        hint="Read-only tools always run; others use this."
      >
        <Select id={id('policy')} value={form.defaultPolicy} onChange={set('defaultPolicy')}>
          <option value="approval">needs approval</option>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </Select>
      </Field>
      {stdio ? (
        <>
          <Field
            label="Command"
            htmlFor={id('command')}
            error={errors.command}
            hint="e.g. npx, or uv (uvx is not installed)."
          >
            <Input
              id={id('command')}
              value={form.command}
              onChange={set('command')}
              {...invalidProps(id('command'), errors.command)}
            />
          </Field>
          <Field label="Working directory" htmlFor={id('cwd')}>
            <Input id={id('cwd')} value={form.cwd} onChange={set('cwd')} />
          </Field>
          <Field
            label="Arguments (one per line)"
            htmlFor={id('args')}
            error={errors.args}
            hint="Reference secrets as ${NAME}."
          >
            <Textarea
              id={id('args')}
              value={form.args}
              onChange={set('args')}
              {...invalidProps(id('args'), errors.args)}
            />
          </Field>
          <Field
            label="Environment (VAR=ENV_LOCAL_NAME per line)"
            htmlFor={id('env')}
            error={errors.env}
            hint="Values come from .env.local at start; only names are stored."
          >
            <Textarea
              id={id('env')}
              value={form.env}
              onChange={set('env')}
              {...invalidProps(id('env'), errors.env)}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL" htmlFor={id('url')} error={errors.url} className="sm:col-span-2">
            <Input
              id={id('url')}
              value={form.url}
              onChange={set('url')}
              {...invalidProps(id('url'), errors.url)}
            />
          </Field>
          <Field
            label="Headers (Name: value per line)"
            htmlFor={id('headers')}
            error={errors.headers}
            className="sm:col-span-2"
            hint="e.g. Authorization: Bearer ${NOTION_TOKEN}. The value lives in .env.local."
          >
            <Textarea
              id={id('headers')}
              value={form.headers}
              onChange={set('headers')}
              {...invalidProps(id('headers'), errors.headers)}
            />
          </Field>
        </>
      )}
      <Field
        label="Domains it calls"
        htmlFor={id('domains')}
        error={errors.domains}
        className="sm:col-span-2"
        hint="For the sandbox network policy. Empty: the defaults shown."
      >
        <Input
          id={id('domains')}
          value={form.domains}
          placeholder={formDefaultDomains(form)}
          onChange={set('domains')}
          {...invalidProps(id('domains'), errors.domains)}
        />
      </Field>
      {!editing && (
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} />
          Give it to every specialist now (the lead keeps its own tools)
        </label>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={save.isPending}>
          {editing ? 'Save' : 'Add server'}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function PasteJsonPanel({ onDone }: { onDone: () => void }) {
  const invalidate = useInvalidate();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedMcpJson | null>(null);
  const add = useMutation({
    mutationFn: async (p: ParsedMcpJson) => {
      const added: string[] = [];
      for (const s of p.servers) added.push((await mcpApi.create(s)).name);
      return added;
    },
    onSuccess: (added) => {
      invalidate();
      toast.success(`Added ${added.join(', ')}`);
      onDone();
    },
    onError: (err) => {
      invalidate();
      toast.error(`Could not add: ${err.message}`);
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Paste an mcpServers config (Claude Desktop, Claude Code, Cursor)"
        htmlFor="mcp-json"
        hint="Secrets in it are not stored: they become .env.local variables you set yourself."
      >
        <Textarea
          id="mcp-json"
          className="min-h-40 font-mono text-xs"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setParsed(null);
          }}
          placeholder='{ "mcpServers": { "notion": { "command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"] } } }'
        />
      </Field>
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setParsed(parseMcpServersJson(text))}
          disabled={!text.trim()}
        >
          Preview
        </Button>
      </div>
      {parsed && (
        <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3 text-sm" aria-label="Preview">
          {parsed.errors.map((e) => (
            <p key={e} role="alert" className="text-destructive">
              {e}
            </p>
          ))}
          {parsed.servers.length > 0 && (
            <>
              <p className="font-medium">Will create:</p>
              <ul className="list-disc space-y-1 pl-5">
                {parsed.servers.map((s) => (
                  <li key={s.slug}>
                    <span className="font-medium">{s.name}</span>{' '}
                    <span className="font-mono text-xs">
                      ({s.slug}, {s.transport}:{' '}
                      {s.transport === 'stdio' ? [s.command, ...(s.args ?? [])].join(' ') : s.url})
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {parsed.moved.length > 0 && (
            <>
              <p className="font-medium">Add these to .env.local (copy the values from your JSON):</p>
              <ul className="list-disc space-y-1 pl-5" aria-label="Secrets to move">
                {parsed.moved.map((m) => (
                  <li key={`${m.server}-${m.variable}`}>
                    <code>{m.variable}=…</code>{' '}
                    <span className="text-muted-foreground">
                      ({m.server}, {m.where})
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {parsed.servers.length > 0 && (
            <div>
              <Button size="sm" onClick={() => add.mutate(parsed)} disabled={add.isPending}>
                Add {parsed.servers.length} server{parsed.servers.length === 1 ? '' : 's'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PresetsPanel({ onUse }: { onUse: (p: McpPreset) => void }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label="Presets">
      {MCP_PRESETS.map((p) => (
        <li key={p.id} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium">{p.name}</span>
            <Button size="sm" variant="outline" onClick={() => onUse(p)} aria-label={`Use preset ${p.name}`}>
              Use
            </Button>
          </div>
          <p className="text-muted-foreground">{p.description}</p>
          <p className="text-xs">
            <span className="text-muted-foreground">Needs: </span>
            {p.env.length
              ? p.env.map((e) => (
                  <code key={e.name} className="mr-1">
                    {e.name}
                  </code>
                ))
              : 'no keys'}
          </p>
          <p className="text-xs">
            <span className="text-muted-foreground">Calls: </span>
            {(p.server.domains ?? []).join(', ')}
          </p>
          {p.env.map((e) => (
            <p key={e.name} className="text-xs text-muted-foreground">
              <code>{e.name}</code>: {e.help}
            </p>
          ))}
          {p.note && <p className="text-xs text-muted-foreground">{p.note}</p>}
        </li>
      ))}
    </ul>
  );
}

type AddMode =
  { kind: 'form'; form: McpServerForm; grant?: boolean } | { kind: 'json' } | { kind: 'presets' };

/** Settings → MCP servers (F35): register external MCP servers for the gateway, test them, set tool policies. */
export function McpServersView() {
  const { data, error } = useQuery({ queryKey: queryKeys.mcpServers, queryFn: mcpApi.list });
  const [add, setAdd] = useState<AddMode | null>(null);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  // Back from an OAuth sign-in page (/api/mcp-oauth/callback redirects here): say how it went, once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has('oauth')) return;
    const ok = q.get('signed-in');
    if (ok) toast.success(`Signed in to ${ok}`);
    else toast.error(`Sign-in failed: ${q.get('error') ?? 'unknown error'}`);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return (
    <div className="flex flex-col gap-6">
      <ResearchCard />
      <section aria-labelledby="mcp-servers-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="space-y-1">
            <h2 id="mcp-servers-heading" className="text-lg font-semibold">
              MCP servers
            </h2>
            <p className="text-sm text-muted-foreground">
              Bots never connect to these directly: the runner does, holds the keys, logs every call and asks
              you before “needs approval” tools run. Remote servers that need an OAuth sign-in get a “Sign in”
              button after “Test connection”; their tokens stay in data/secrets.
            </p>
          </div>
          <div className="flex gap-2" role="group" aria-label="Add a server">
            <Button size="sm" onClick={() => setAdd({ kind: 'form', form: emptyMcpForm })}>
              Add server
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdd({ kind: 'json' })}>
              Paste JSON
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAdd({ kind: 'presets' })}>
              Presets
            </Button>
          </div>
        </div>
        {add && (
          <div className="rounded-lg border p-4">
            {add.kind === 'form' && (
              <ServerFormPanel
                key={JSON.stringify(add.form)}
                initial={add.form}
                grantDefault={add.grant}
                onDone={() => setAdd(null)}
              />
            )}
            {add.kind === 'json' && <PasteJsonPanel onDone={() => setAdd(null)} />}
            {add.kind === 'presets' && (
              <PresetsPanel
                onUse={(p) => setAdd({ kind: 'form', form: serverToForm(p.server), grant: p.teamDefault })}
              />
            )}
          </div>
        )}
        {editing && (
          <div className="rounded-lg border p-4">
            <ServerFormPanel
              key={editing.id}
              initial={serverToForm(editing)}
              editing={editing}
              onDone={() => setEditing(null)}
            />
          </div>
        )}
        {data?.length ? (
          data.map((s) => <ServerCard key={s.id} server={s} onEdit={() => setEditing(s)} />)
        ) : (
          <p className="text-sm text-muted-foreground">
            {error ? `Could not load: ${error.message}` : data ? 'No MCP servers yet.' : 'Loading…'}
          </p>
        )}
      </section>
    </div>
  );
}
