# Security review (F33)

Agent A is a single-owner app on one laptop. It has **no login**: whoever can reach port 3000 controls the team, the
bot computers and their connectors. The design rests on three walls, from outside in:

1. **Network reach.** Only the owner's machine can reach the web server: everything binds to `127.0.0.1` inside the
   Docker Sandbox VM, and the sandbox publishes port 3000 to `127.0.0.1` on the Windows host
   (`sbx create … -p 127.0.0.1:3000:3000`).
2. **The browser.** Other websites the owner visits must not drive the API. That is the request guard below.
3. **Bot computers.** Each bot runs in its own container with limits, and can reach only its home, the team share and
   the platform MCP server with its own token.

Last reviewed: 2026-10-15 (F33 session 2). Every row below was checked against the running app or the code named,
not assumed.

## Checklist

| Area | Check | How it was verified | Result |
|---|---|---|---|
| Binding | Web 3000, runner 3001 and MCP 3002 listen on `127.0.0.1` only. MCP also listens on the bot network gateway, so containers can reach it. | `ss -ltn` with `pnpm dev` running | ✅ `127.0.0.1:3000/3001/3002` and `172.19.0.1:3002`. Nothing on `0.0.0.0`. |
| Binding | Windows host publishes 3000 to loopback only | HUMAN_TODO 4 (`-p 127.0.0.1:3000:3000`) | ✅ Owner action, already done |
| CSRF | A page on another site can't send writes to the API | `request-guard.ts`; unit `test/request-guard.test.ts`; e2e `resilience.spec.ts` through the Next proxy | ✅ **Fixed in F33.** Before the fix, a cross-site `POST /api/onboarding/team` from any website reset the team. |
| DNS rebinding | A foreign host name pointing at 127.0.0.1 can't read or write the API | Same tests, using a `Host: rebind.evil.example` request | ✅ **Fixed in F33.** Returns 403 for every method. |
| WebSockets | The live, terminal and desktop sockets refuse foreign origins | `live/routes.ts`, `server.ts` origin checks; `ws.test.ts` | ✅ |
| Path traversal | The Files API stays inside the bot home or the team share | Live probe: `../../etc/passwd`, encoded `%2e%2e`, absolute paths and `work/../../..` (`files/store.ts`: realpath containment, symlink-aware) | ✅ All return 403 `outside_root` |
| Tokens: MCP | Per-bot bearer token is random, the file is 0600, the DB stores only its SHA-256 | `bots/mcp-token.ts`; DB scan | ✅ No `agm_` token in any DB or backup |
| Tokens: engines | `CLAUDE_CODE_OAUTH_TOKEN` comes from `.env.local` and is passed per exec, never in the container env or the DB | `engines/secrets.ts`, `engines/auth.ts` | ✅ |
| Tokens: GitHub | `GH_TOKEN` is passed only to enabled bots, per exec or terminal, never stored | `connectors/service.ts` | ✅ |
| Secrets in DB | No token-shaped strings in the owner's DB or the e2e DB (incl. WAL) | Pattern scan for `agm_`, `ghp_/gho_/…`, `github_pat_`, `sk-ant-`, `sk-…`, OAuth `access_token`/`refresh_token`, and the e2e gateway secret. Positive control: the scan finds a real `mcp-token` file. | ✅ 0 hits |
| Secrets in logs | pino redacts auth headers and engine/GitHub tokens; nothing token-like is logged | Scanned the runner and web log at `LOG_LEVEL=debug` across the chat, approvals and MCP-gateway e2e specs (the gateway's secret key included) | ✅ 0 hits in 1,799 lines; no `Bearer`/`authorization` lines |
| Secrets in backups | Backups leave out `data/secrets`, `.env.local` and every credential file in bot homes | `backup/archive.ts` `HOME_SECRETS`; `tar -tzf` on a backup; pattern scan of 3 backups (DB, `bots.tar.gz`, `shared.tar.gz`) | ✅ 0 credential paths, 0 hits |
| Containers | Memory (no swap), CPU, a 512 PID limit, `CapDrop: ALL`, `no-new-privileges`, non-privileged, no restart policy, noVNC published on 127.0.0.1 only | `containers/docker.ts`, `containers/spec.ts`; `manager.test.ts` | ✅ |
| Containers | Idle computers stop after 30 min by default; stopped computers use no RAM | `manager.ts` idle sweep; measured an idle running computer with `docker stats` | ✅ 86 MiB idle, so 7 running bots ≈ 0.6 GB (under the 1 GB target), and 0 when stopped |
| Docker scope | The app touches only resources labelled `agenta=1` | `manager.ts` reconcile | ✅ |

## The request guard (`apps/runner/src/request-guard.ts`)

Every request reaches the runner through the Next.js proxy, which forwards `Origin`, `Sec-Fetch-Site` and
`X-Forwarded-Host`. A Fastify `onRequest` hook refuses requests with `403 forbidden_request`:

- **Host check (all methods).** `X-Forwarded-Host`, or `Host` when that header is absent, must be one of:
  `localhost`, `127.0.0.1`, `[::1]`, the `AGENTA_WEB_ORIGIN` host, or a name listed in `AGENTA_ALLOWED_HOSTS`.
  This defeats DNS rebinding.
- **Unsafe methods (POST/PUT/PATCH/DELETE).** These need an `Origin` whose host equals the requested host (or the
  web origin). If there is no `Origin`, then `Sec-Fetch-Site` must not be `cross-site` or `same-site`.
  `same-site` is refused too: another app on `localhost:8080` counts as the same site.
- **What still passes.** GETs are open, so the OAuth callbacks of MCP servers (cross-site navigations) keep working.
  Local scripts, tests and `curl` send neither header and pass.

If the owner reaches the UI by a LAN name or IP, that name goes in `AGENTA_ALLOWED_HOSTS`.

## Accepted risks

- **No login.** The guard stops other websites, but any local process, or anyone who can reach port 3000, has full
  control. Keep the host-side publish on `127.0.0.1`. `AGENTA_WEB_HOST=0.0.0.0` inside the VM is only safe because of
  that publish.
- **Bots can read their own credentials.** The Codex `auth.json` is copied into the bot's home: the Codex CLI needs
  it, and the CLI runs as the bot user. `GH_TOKEN` and the Claude token sit in the bot's process environment while
  it runs. A prompt-injected bot could leak them. Mitigations:
  - approvals before push, PR, comment or deploy actions (F25, F29);
  - GitHub access only for the bots ticked in Settings → Connectors;
  - outbound traffic limited by the sandbox network policy.
  Use fine-grained, short-lived GitHub tokens.
- **Bot network egress.** It isn't filtered per bot inside the VM; only the sandbox-wide policy applies.
- **TOCTOU on file paths.** A bot could swap a folder for a symlink between the path check and the write. This is out
  of scope (`files/store.ts`): the bot already owns everything in its home.

## Re-running the checks

```bash
pnpm test -- request-guard                    # guard unit tests
pnpm exec playwright test resilience a11y     # guard through the proxy, WS drop, WCAG + keyboard
ss -ltn | grep -E ':300[0-2] '                # with pnpm dev running: 127.0.0.1 only
```
