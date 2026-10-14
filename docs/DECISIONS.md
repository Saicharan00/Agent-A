# Design decisions

One short entry per non-obvious choice. Newest at the bottom.

## F01 — Environment setup (reproducible)
The sandbox VM (Ubuntu 26.04, user `agent`, passwordless sudo) already ships Node 22.22.1, git, python3, the Docker
client and its own private Docker daemon (29.8.1). Added in F01:
1. Network: the owner allowed these domains for sandbox `agent-a` (`sbx policy allow network --sandbox agent-a <domain>`):
   registry.npmjs.org, github.com, objects.githubusercontent.com, codeload.github.com, nodejs.org,
   registry-1.docker.io, auth.docker.io, production.cloudflare.docker.com, cdn.playwright.dev,
   playwright.download.prss.microsoft.com, archive.ubuntu.com, security.ubuntu.com.
   Added later: storage.googleapis.com (Playwright's Chrome download), production.cloudfront.docker.com (Docker Hub blobs).
2. pnpm: `npm i -g pnpm@10` (installs into /usr/local/share/npm-global). Corepack's bundled version (0.24) cannot run
   pnpm 12, so corepack is not used; `packageManager` pins pnpm@10.34.7.
3. apt: `download.docker.com` is blocked, which makes plain `apt-get update` fail. Workaround that only uses the Ubuntu
   archive: `mkdir -p /tmp/aptparts && cp /etc/apt/sources.list.d/ubuntu.sources /tmp/aptparts/` then
   `sudo apt-get update -o Dir::Etc::sourceparts=/tmp/aptparts` and
   `sudo apt-get install -y -o Dir::Etc::sourceparts=/tmp/aptparts build-essential sqlite3 iproute2`.
4. Playwright system libraries: the package list from `pnpm exec playwright install-deps --dry-run chromium`,
   installed with the same apt workaround. Browser: `pnpm exec playwright install chromium` (into ~/.cache/ms-playwright).

## F01 — node_modules and .next live on the VM's Linux disk (bind mounts)
The project folder is the owner's Windows folder mounted via virtiofs. It forbids symlinks (pnpm's default layout)
and pnpm's rename-based installs fail with EACCES on it. `scripts/vm-mounts.sh` bind-mounts
`~/.cache/agenta-vm/<dir>` over every `node_modules` dir and `apps/web/.next`. It is idempotent and is invoked from
`/etc/sandbox-persistent.sh` (sourced before every shell command), so the mounts come back after a VM restart.
Side effect: Windows sees those dirs as empty. They are git-ignored build artefacts, so this is harmless.
Also set in `.npmrc`: `node-linker=hoisted`, `package-import-method=copy`, and a pnpm store outside the project.

## F01 — Workspace packages resolve via tsconfig paths, not workspace links
Because of the symlink restriction (above), apps do not declare `workspace:*` dependencies on `@agenta/shared` /
`@agenta/db`. Instead `tsconfig.base.json` maps them to their `src/index.ts`; tsc, tsx (runner), Next.js and
Vitest (`resolve.tsconfigPaths`) all honour these paths. Packages ship TypeScript source; nothing is prebuilt.

## F01 — Runner runs TypeScript via tsx in dev and prod
`pnpm start` for the runner uses `tsx src/index.ts` rather than compiling to `dist/`, because it imports
TypeScript source from workspace packages. `pnpm build` for the runner is a typecheck.

## F01 — Browser talks only to the web origin; /api is proxied to the runner
`apps/web/next.config.ts` rewrites `/api/*` to `AGENTA_RUNNER_URL` (default http://127.0.0.1:3001). The owner's
Windows browser can only reach port 3000 (sbx publishes just that port), and this keeps the runner on 127.0.0.1.
The runner still sets CORS for `http://localhost:3000` only, as specified. WebSockets (F11) will need their own
proxy path; Next rewrites don't carry WS upgrades.

## F01 — Reaching the UI from Windows (port 3000)
The sandbox was created with `-p 127.0.0.1:3000:3000`, so on Windows the port is only bound to localhost. sbx docs
say a published port reaches a service only if it listens on the VM's `eth0`, not 127.0.0.1. CLAUDE.md requires
127.0.0.1, so that stays the default. `AGENTA_WEB_HOST` (in `.env.local`) lets the owner bind the **web** server
to 0.0.0.0 if http://localhost:3000 doesn't load on Windows (HUMAN_TODO item 9). The runner and MCP servers always
stay on 127.0.0.1. Caveat for F05: with the web on 0.0.0.0, bot containers can route to the VM's eth0 address, so
F05 must block bot-network → VM:3000 (iptables) or the web must authenticate proxied API calls.

## F01 — Script runner and `pnpm doctor`
Root scripts (`check:secrets`, `doctor`, `image:build`) are TypeScript run with `tsx` (Node 22.22 does not strip
types by default). `pnpm doctor` is a pnpm built-in that shadows the script, so use **`pnpm run doctor`**.

## F01 — Tool versions
TypeScript is pinned to ~6.0 because typescript-eslint 8.x supports `<6.1` (TS 7, the native port, is not
supported yet). ESLint 10 flat config + typescript-eslint + @next/eslint-plugin-next + eslint-config-prettier.
Next.js telemetry is disabled in the launcher and `agentRules: false` stops Next from writing `apps/web/AGENTS.md`.
New deps: concurrently (dev script), tsx (runner + scripts), globals (ESLint), eslint-config-prettier.

## F02 — Data layer shape
- **Sync repositories.** better-sqlite3 is synchronous, so repos return values (not Promises) and use Drizzle's
  `.get()/.all()/.run()`. `createRepos(db)` (packages/db) is the only place SQL lives.
- **Repos validate their own input** with the zod DTOs from `packages/shared/src/dto.ts` (defaults applied there),
  so the runner, MCP tools and seeds all get the same validation, not just HTTP routes.
- **Enums live in `packages/shared/src/enums.ts`** and both the Drizzle schema and the zod DTOs import them.
  drizzle-kit resolves the `@agenta/shared/*` tsconfig path alias, so no duplication is needed.
- **Migrations:** drizzle-kit SQL files in `packages/db/drizzle/`, applied by `openDb()` (drizzle migrator,
  tracked in `__drizzle_migrations`, idempotent). The runner opens the DB on start, so it always auto-migrates.
  `pnpm db:generate` after editing `schema.ts`.
- **Pragmas per connection:** WAL, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL` (safe with WAL).
- **Columns added beyond PLAN's list:** `runs.created_at` (queue FIFO order) and `schedules.created_at`
  (stable listing). `run_events.id` is an INTEGER autoincrement (high-volume, never referenced by id).
- **Stable ordering:** IDs are random and timestamps are millisecond-resolution, so lists that must keep
  insertion order (messages, runs queue, task events) tie-break on SQLite's `rowid`.
- **Polymorphic references are not FKs:** `tasks.created_by`, `decisions.created_by` ('user' or a bot id) and
  `lessons.source_id`. Other references are FKs: owned children cascade (members, messages, run events, sessions),
  optional links `SET NULL` (a deleted bot unassigns its tasks rather than deleting them).
- **DB location:** `AGENTA_DB_PATH` (absolute or repo-relative), default `data/agenta.db`. Playwright uses
  `data/e2e/agenta.db` so e2e runs never touch the owner's data. Unit tests use a fresh temp file per test.
- **New deps:** `better-sqlite3` + `drizzle-orm` (+ dev `drizzle-kit`, `@types/better-sqlite3`) in packages/db;
  `nanoid` in packages/shared (IDs). `better-sqlite3` added to `onlyBuiltDependencies` for its native build.

## F03 — App shell
- **New web deps:** `@tanstack/react-query` (stack), `cmdk` (Ctrl+K palette: filtering, keyboard nav, accessible
  dialog), `sonner` (toasts). Components are hand-written in shadcn style (`components/ui/button.tsx` + cva) rather than
  pulled with the shadcn CLI, which needs ui.shadcn.com through the sandbox proxy; add more the same way as needed.
- **Theme without flash:** the theme is saved in localStorage (as specified) *and* mirrored to an `agenta.theme`
  cookie; the root layout reads the cookie and renders `class="dark"` on `<html>` server-side. An inline `<script>`
  triggered a React 19 warning, and `next/script beforeInteractive` turned out to run after Next boots (dark flash for
  light users). Cost: every route is dynamically rendered, irrelevant for a local single-user app.
- **Shortcuts:** `Ctrl+K` palette, `Ctrl+B` sidebar, `Ctrl+\` Computer panel (`Ctrl+J`/`Ctrl+.` collide with browser or
  OS bindings), `Ctrl+Enter` reserved for send (F13). `Ctrl` also matches ⌘. Sidebar/panel/tab state persists in localStorage.
- **Next dev config:** `allowedDevOrigins: ['127.0.0.1','localhost']`: with `AGENTA_WEB_HOST=0.0.0.0`, Next 16 blocks
  the hot-reload socket for 127.0.0.1 as cross-origin (console errors). `devIndicators: false`: the floating badge
  covered the sidebar footer. Playwright forces `AGENTA_WEB_HOST=127.0.0.1` so e2e never exposes the server.
- **Engine pills** (Claude/Codex/Docker) are neutral placeholders; the Runner pill is live (`/api/health` every 15s).
  Pills hide when the Computer panel is open below 2xl so the search stays usable at 1280px.
- **`useLiveChannel`** is a skeleton (`lib/live-channel.ts`, capped exponential backoff with jitter, subscribe-on-open)
  and defaults to `enabled: false`: no server exists until F11, and failed connection attempts would log console errors.

## F04 — Bot computer image
- **User `bot` = the base image's `node` user renamed** (it already owns uid/gid 1000). The image runs as `bot`
  (`USER bot`), so the entrypoint and every `docker exec` are non-root by default; the entrypoint only `mkdir`s.
- **Proxy CA baked in.** The Docker Sandbox proxy re-signs TLS for some hosts (observed: `api.anthropic.com`,
  `registry-1.docker.io`) with "Docker Sandboxes Proxy CA". `pnpm image:build` copies
  `/usr/local/share/ca-certificates/proxy-ca.crt` into `docker/bot/certs/` (git-ignored `*.crt`), the Dockerfile adds it
  to the system store, and `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE` point at the bundle.
  Without it the engines inside bots would fail TLS. It is a public CA cert, not a secret.
- **Proxy at build time:** `docker build` doesn't forward the shell's proxy env, so `image:build` passes
  `HTTP(S)_PROXY`/`NO_PROXY` as build args (predefined ARGs: not persisted in the image). Runtime proxy env for bot
  containers is F05's job.
- **`gh` from the official apt repo (`cli.github.com`).** The release tarball redirects to
  `release-assets.githubusercontent.com`, which would need an extra domain allow anyway; apt is the documented path.
- **Playwright version pinned to `@playwright/mcp`'s own dependency** (an alpha build), installed globally as the
  `playwright` CLI, so `playwright install chromium` fetches the exact browser revision the MCP server launches.
  Browsers live in `/opt/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`), world-readable.
- **Desktop supervision:** a tiny bash restart loop per daemon (Xvfb, fluxbox, x11vnc, websockify) instead of
  supervisord: four processes, no extra package. Logs in `/tmp/agenta/*.log`. x11vnc listens on container-local
  `127.0.0.1:5900` only; websockify serves noVNC on `:6080`, which F05 publishes to `127.0.0.1:<random>`.
- **Engine versions** default to `latest` at build time (build args `CLAUDE_CODE_VERSION`, `CODEX_VERSION`,
  `PLAYWRIGHT_MCP_VERSION` can pin them); the observed versions are recorded in `docs/engines.md`.
  `DISABLE_AUTOUPDATER=1` so Claude Code doesn't try to update itself inside bots.

## F05 — Container lifecycle manager
- **Bot homes live on the VM disk.** The workspace (virtiofs) refuses symlinks, also inside containers, which would
  break npm, Python venvs and git in bots. `data/bots` and `data/shared` keep their PLAN paths but are bind-mounted
  from `~/.cache/agenta-vm/` by `scripts/vm-mounts.sh` (same mechanism as node_modules). The runner probes both dirs
  for symlink support before creating a container and fails with `storage_unsupported` otherwise. Trade-off: the
  owner can't browse bot files from Windows Explorer (F15 Files UI covers that); they persist with the sandbox VM.
- **`host.docker.internal` → the `agenta-net` gateway IP**, not Docker's `host-gateway` (which resolves to `fe80::1`,
  unusable, in this VM). F17's MCP server must therefore listen on that gateway IP as well as 127.0.0.1; it is
  reachable only from bot containers on the bridge, never from outside the VM.
- **No capabilities at all** (`CapDrop: ALL`, `CapAdd: []`), `no-new-privileges`, PidsLimit 512, swap = memory limit,
  restart policy `no`, no Docker socket, binds = home + /shared only, 6080 published to `127.0.0.1:<random>`.
  The image runs as uid 1000 and the runner bootstraps the home itself (Docker would create `work/` as root).
- **Default bot memory 2 GB** (DTO default lowered from F02's 4096 to match PLAN; the VM has ~7 GB).
- **Proxy env in containers** (HTTP(S)_PROXY from the runner env; NO_PROXY always adds host.docker.internal/localhost).
  Exec-time `env` (F06 tokens) is passed per exec and never stored on the container.
- **`DockerApi` interface** (containers/docker.ts) wraps the dockerode calls the manager needs; unit tests use an
  in-memory `FakeDocker`. Real-Docker tests live in `apps/runner/test-docker/*.docker.test.ts`, run by
  `pnpm test:docker` (not part of `pnpm test`).
- **Lifecycle details:** per-bot promise lock serializes start/stop/reset; containers are found by label
  `agenta.bot=<id>` (the name `agenta-bot-<slug>` gets an id suffix on conflict); `reset` removes the container and
  restarts it if it was running; the published port is stored in label `agenta.port` for adopted containers.
  Bot containers keep running when the runner stops; reconcile (startup + 60 s) adopts them, marks vanished ones
  stopped, and only *stops* orphans. Idle sweep (60 s) stops computers idle > `idleTimeoutMin` (0 = never); runs and
  terminals hold leases via `acquire()`/`execTty()`.
- **Event bus stub:** `apps/runner/src/bus.ts` (EventEmitter, channel → listeners); F11 adds WebSocket fan-out.
- **New deps:** `dockerode` (stack) + dev `@types/dockerode`.

## F06 — Engine authentication plumbing (2026-10-12)
- **Claude token = exec-time env only.** `CLAUDE_CODE_OAUTH_TOKEN` is passed per `docker exec` for engine runs (and the
  CLI status check), never as container Env, never written into the bot home. Plain execs/terminals don't get it, so
  it doesn't leak into terminal history or `env` output by default. pino redacts `*.CLAUDE_CODE_OAUTH_TOKEN` paths.
- **Secrets are re-read from `.env.local`** (mtime-cached) instead of only at startup, so a pasted token works after
  "Re-check" without a restart. A variable set by the shell (even to "") wins; the runner snapshots `process.env`
  *before* loading .env.local to know which is which. Playwright uses this to force engines to "missing".
- **Codex shared login sync**: copy-in before container start and before each Codex run; copy-back after runs when the
  bot copy is newer and the same account; lock file (`auth.json.lock`, O_EXCL, stale after 30 s) instead of a new
  dependency; mtimes preserved on copy so "newer" means newer token. Different-account copies = per-bot login, untouched.
- **Status checks never send a prompt.** Base status is host-side (token shape, auth.json shape/JWT claims). "Re-check"
  (`?verify=1`) additionally runs `claude auth status` / `codex login status` (both verified offline) inside an
  already-running bot computer; it never starts one just to check.
- **Login helpers** `pnpm auth:claude` / `pnpm auth:codex` run the CLIs in a throwaway `agenta-bot` container
  (labelled `agenta=1`), so the owner needs nothing installed in the VM; the Claude token is read with hidden input
  and written to `.env.local` (600), the Codex auth.json goes to `data/secrets/codex/auth.json` (600).
- **Smoke test** `SMOKE=1 pnpm smoke:auth` (tests/smoke, own vitest config, not in `pnpm test`): one "reply OK" prompt
  per configured engine in a throwaway container.
- No new dependencies.

## F07 — Engine adapter interface & mock engine (2026-10-12)
- **`EngineEvent` lives in `packages/shared/src/events.ts`** as a zod discriminated union (PLAN §2 shape, unchanged);
  run_events rows and WebSocket frames will validate against it. Additive changes only.
- **Adapter contract:** `run(input, signal)` yields events and always ends with exactly one `run.finished`; an aborted
  signal ends the run promptly with `cancelled`. Tests assert these invariants for every mock scenario.
- **Mock engine** is an async generator driven by a per-scenario script that yields delays; time comes from an
  injectable `MockClock` (`fakeClock()` advances virtual time, so the 20 s `[mock:slow]` test runs instantly).
  Session id is deterministic (`mock-<botId>-<threadId>`, or the resumed id). `[mock:delegate]` emits
  `mcp__agenta__*` tool calls; results come from an injectable `platform` (stub text until F17).
- **`EngineRegistry`** resolves a bot's adapter; `AGENTA_ENGINE_OVERRIDE=mock` makes `effectiveEngine()` return mock
  for every bot. Claude/Codex adapters register in F08/F09; until then asking for them throws `engine_unavailable`.
- **JSONL parser:** StringDecoder for split UTF-8, CRLF tolerant, non-JSON lines go to `onNoise` (debug log; they
  include the image entrypoint banner), oversized lines (default 8 MiB) dropped and reported, parser recovers.
- **Prompt builder** is pure (plain data in, text out) with snapshot tests. A plain DM turn is sent verbatim; group/
  task turns get a "messages since your last turn" block (author, minute-precision UTC time, "mentions you"), task
  context, and the explain-mode instructions. CLAUDE.md and AGENTS.md get identical rendered content (instructions,
  computer layout, memory + team knowledge; memory empty until F22) and are rewritten atomically before each run.
- `pnpm mock:run "<prompt>"` prints a scenario's event stream (manual check; Ctrl+C → cancelled).
- No new dependencies.

## F08 — Claude Code adapter (2026-10-13)
- **Prompt via stdin from a per-run file**, system text via `--append-system-prompt-file` (both under
  `/home/bot/.agenta/runs/<uuid>/`, mode 600, deleted after the run): no argv length/escaping limits, prompt not in `ps`.
- **New sessions get `--session-id <uuid>`** chosen by the runner, so `run.started` carries the id immediately;
  `run.finished.sessionId` is the id the CLI reported (authoritative for `bot_thread_sessions`).
- **Process groups for cancel.** Docker has no "kill exec" API, so engine CLIs run under `setsid -w` and write their
  pgid to `/tmp`; `ContainerLauncher.signal()` kills the group with a second exec. Cancel = SIGINT, SIGKILL after 5 s,
  and always a final group SIGKILL (background tool processes ignore SIGINT). If the stream still doesn't close 3 s
  after SIGKILL the adapter stops waiting. A consumer that stops iterating early also reaps the group.
  `process.ts` is engine-agnostic so F09 reuses it.
- **New `system` EngineEvent** (`{ type: 'system', message }`, additive) for platform notes about a run, first used
  when `--resume` fails because the session is gone (retry once without resume).
- **Mapping choices:** sub-agent (Task) text/thinking is dropped (not the bot's reply), sub-agent tool calls are kept;
  `usage.inputTokens` = input + cache-creation + cache-read tokens (what the turn really processed);
  `costUsdEquivalent` = `total_cost_usd`; `is_error` beats `subtype` (API errors arrive as `subtype: "success"`).
- **MCP config** is passed only when the file exists (rendered in F17), so runs work before then.
- **Limit detection** prefers the structured `rate_limit_event` (`status: "rejected"`, `resetsAt` epoch seconds),
  then `error: "rate_limit"`, then wording; `limits.ts` parses epoch/ISO/relative/wall-clock+IANA-zone reset times and
  will be reused by Codex. The limit fixture is synthesized from observed shapes (no real limit hit yet).
- Smoke test `SMOKE=1 pnpm smoke:claude` (tests/smoke now resolves `@agenta/*` via tsconfig paths).
- No new dependencies (`setsid` is util-linux, already in the bot image).

## F09 — Codex adapter (2026-10-13)
- **Shared CLI run loop** (`engines/cli.ts`, abstract `CliEngine`): per-run prompt files, spawn via the F08 launcher,
  JSONL mapping, cancel (SIGINT → SIGKILL → group reap), one retry when the resumed session is gone, optional
  before/after hooks. `ClaudeEngine` and `CodexEngine` only supply argv, a stream mapper and hooks.
- **Codex instructions:** system text via `-c developer_instructions=…` (Codex has no system-prompt flag); the rendered
  `/home/bot/AGENTS.md` is mirrored to `~/.codex/AGENTS.md` before each run because Codex never reads AGENTS.md above its
  cwd outside a git repo. Both verified offline with `codex debug prompt-input` (Docker test).
- **`~/.codex/config.toml` is runner-rendered before each run** (not by the container manager): no Codex sandbox or
  approvals, Playwright MCP, plus the servers from the bot's Claude-style `mcp.json` translated to TOML, so F17 only
  writes one MCP config for both engines. Edits by hand are overwritten.
- **Auth:** `EngineAuth.beforeCodexRun` is a before-hook (a failure fails the run before Codex starts);
  `afterCodexRun` runs after every attempt that started, including cancels.
- **Mapping:** `run.started` has no session id for a new thread (Codex reports it in `thread.started`);
  `run.finished.sessionId` carries it. Shell commands are `shell` tool calls; `file_change` → `apply_patch` +
  `file.changed`; MCP calls use Claude's `mcp__server__tool` naming so the UI treats both engines alike; transient
  `Reconnecting…` errors and `error` items are ignored; usage input = `input_tokens` (already includes cached),
  output = output + reasoning tokens; no cost (Codex doesn't report one).
- Reset-time parser learned Codex's "try again at 3:05 PM" / "at Oct 14th, 2026 9:05 AM" wording.
- No new dependencies.

## F10 — Run orchestrator (2026-10-13)
- **One in-process scheduler** (`runs/service.ts`, `RunService`). `tick()` is synchronous: it walks queued runs FIFO
  and starts each one unless the global cap (`settings.maxConcurrentRuns`, default 2, counts every engine incl. mock),
  the bot's one-run-at-a-time rule, or a paused engine (`engine_state.limited_until > now`) holds it back. A later
  run of another bot may overtake a blocked one (per-bot FIFO, not global head-of-line blocking). Wake-ups on
  enqueue/finish are coalesced with `setImmediate`; a 5 s poll covers limits expiring.
- **The run's engine is fixed at enqueue** (`EngineRegistry.effectiveEngine`, so the mock override is recorded on the
  row) and that is the engine whose limit state gates it.
- **Events are written in small batches** (50 ms window; `text.final`, tool events and `run.finished` flush at once)
  and published on `run:<id>` only *after* the batch committed, so the DB is never behind the bus: F11 can subscribe,
  then replay `afterSeq`, and de-duplicate by `seq`.
- **The orchestrator owns `run.finished`.** The adapter's `run.finished` is not stored; the service writes exactly one
  with the final status (which can differ: timeout → failed). The adapter's status and session id are kept.
- **Bot reply = one message per run**, created on the first `text.final` and extended by later ones (joined with a blank
  line; Codex and Claude emit several complete messages per turn). Published as `message.created/updated` on
  `thread:<id>`. Deltas are not written to the message (the UI streams them from `run:<id>`).
- **Session id** is saved to `bot_thread_sessions` at `run.started` (so a crash mid-run can still resume) and at the end.
  A stored session from another engine is not resumed. `last_seen_message_id` is left to the callers that build group
  prompts (F13/F18).
- **Computer preparation** (`runs/prepare.ts`): real engines start the container on demand, hold a container lease for
  the whole run (idle sweep can't stop it between execs), bootstrap the home and render CLAUDE.md/AGENTS.md. The mock
  engine skips all of it, so tests and e2e need no Docker. The MCP config is written in F17.
- Live event shapes live in `packages/shared/src/live.ts` (`run.event`, `run.updated`, `message.*`, `engine.state`).
- No new dependencies.
- **Usage-limit retry is a new run**, not a re-queue of the limited one: the limited run keeps its status, events and
  single `run.finished`; the retry is a queued copy with the new column `runs.retry_of_run_id` (migration 0001) and
  simply waits in the queue until the engine's pause expires. A retry that hits the limit again is not retried. The
  pause is the parsed reset time when it is in the future, else now + 30 min; concurrent hits keep the later time.
  Expired pauses are cleared by the scheduler, which publishes `engine.state` on `global`. Notification kind
  `engine.limited`, link `/usage`.
- **drizzle-kit dropped `ON DELETE set null` from the ALTER TABLE**; 0001 was edited by hand to keep it (verified with
  `PRAGMA foreign_key_list(runs)` and a delete).
- **Transient-failure retry (once per run):** computer preparation errors with codes `start_failed`, `start_timeout`,
  `container_missing`, network errno codes, or Docker 5xx; and engine attempts that produced no output and reported an
  `error` with the new optional `code: "exec_failed"` (CliEngine sets it when setup/spawn fails). Permanent problems
  (image missing, storage unsupported, engine/API errors) fail at once. Both attempts' events stay in the run's stream,
  separated by a `system` "retrying once" event.
- **Timeout** (default 30 min, `bot.settings.runTimeoutMin` optional) aborts the engine like a cancel but the run ends
  `failed` with "Timed out after N min". **Graceful shutdown** aborts running engines and records them `failed`
  ("runner stopped", bounded 8 s wait); after a crash, start-up recovery marks leftovers `failed` ("runner restarted").
  Neither re-queues: replaying a half-done turn could repeat its side effects.
- Runs API: `GET /api/runs?botId=&threadId=&taskId=&status=a,b&limit=`, `GET /api/runs/:id`,
  `GET /api/runs/:id/events?afterSeq=&limit=` (`{ runId, status, events }`), `POST /api/runs/:id/cancel` (404 unknown,
  409 already finished; waits up to 15 s for a running engine to stop).

## F11 — Realtime event bus & WebSocket (2026-10-13)
- **New dependency `@fastify/websocket`** (in the planned stack; brings `ws`). Tests use Node 22's built-in
  `WebSocket` client, so no client dependency.
- **The browser reaches `/ws` through Next**, like `/api`: a `/ws` rewrite to the runner; Next 16 proxies the upgrade
  for external rewrites. The runner stays on 127.0.0.1 and port 3000 remains the only published port.
- **One multiplexed socket per tab** (`LiveConnection`, `LiveProvider`) instead of one socket per channel: refcounted
  channel listeners, one server subscription per channel. Wire protocol in `packages/shared/src/live.ts`
  (`subscribe {channel, afterSeq?}` / `unsubscribe` / `ping`; server sends `event`, `subscribed`, `unsubscribed`,
  `ping`/`pong`, `error`).
- **Replay only on `run:` channels.** The server subscribes to the bus and reads `run_events` after `afterSeq` in one
  synchronous block (the writer publishes after commit), then streams live events de-duplicated by seq; the client
  also de-duplicates and re-subscribes with its last seq after a reconnect. Other channels carry state changes the
  REST API can re-read, so after a reconnect the client invalidates all queries instead of replaying them.
- **Heartbeat** every 20 s: a protocol ping (peers silent for a whole period are terminated) plus an app-level `ping`
  frame, because browsers can't see protocol pings; the client reconnects after 50 s without any frame. Slow
  consumers (> 8 MB buffered) are dropped and replay on reconnect. Max 256 channels per socket, 64 KB client frames.
- **Origin check on the upgrade**: only the web origin and its localhost/127.0.0.1/[::1] aliases on the same port
  (browsers apply no CORS to WebSockets); no Origin (local scripts/tests) is allowed.
- **Engine pills** combine auth (F06) with the new `GET /api/engines/state` (`{ override, engines: [{ engine,
  limitedUntil }] }`, expired pauses reported as null), patched live by `engine.state`. With
  `AGENTA_ENGINE_OVERRIDE=mock` all runs (and their limits) are on the mock engine, so a "Mock" pill appears only then
  and shows its pause; that is what the Playwright check watches.
- **Docker pill goes live** via `DockerMonitor` (10 s poll in the runner, `docker.state` on `global` only on change).
- Query keys for later features are fixed in `apps/web/lib/query-keys.ts` (lists under `'list'`), and
  `lib/live-cache.ts` patches bot/run status and growing messages in cached arrays, and invalidates on new messages.

## F12 — Bot management (2026-10-13)
- **API** (`apps/runner/src/bots/`): `GET /api/bots?archived=exclude|include|only`, `POST /api/bots`,
  `GET/PATCH/DELETE /api/bots/:id`, `POST /api/bots/:id/{archive,restore,duplicate}`. Request schemas are
  `.strict()` variants of the F02 DTOs without `isLead` (the lead is seeded by the platform in F21, and the lead can't
  be archived or deleted). Responses are `BotView`: the row minus `mcpTokenHash`/`containerId`/`novncPort`, plus
  `dmThreadId` and `lastActivityAt` (latest run created/started/finished).
- **Explicit handles must be free** (409 `slug_taken`); a blank handle is derived from the name and auto-suffixed
  (`writer-2`). Renames keep the handle (it is what @mentions use) but retitle the DM thread.
- **MCP token: plaintext in one file, not yet in an MCP config.** Creating a bot writes `agm_<32 random bytes>` to
  `<home>/.agenta/mcp-token` (mode 600, owned by the bot user) and stores only its SHA-256 in `mcp_token_hash`. F17
  renders `~/.agenta/mcp.json` from that file. Writing an `agenta` MCP server entry now would point both engines at a
  server that doesn't exist until F17. Before every real run the token is re-checked against the hash and re-issued
  if the home lost it (e.g. a home wipe). `verifyMcpToken` compares in constant time.
- **Limits and handle are baked into the container at create time.** After a change to RAM/CPUs/handle, a stopped
  container is removed (recreated lazily, home kept); a running one is left alone and the PATCH answers
  `restartRequired: true` (UI toast). Idle/run timeouts are read live and need neither.
- **Archive** sets `archived_at` first (so `enqueue` refuses new runs), cancels queued/running runs, stops the computer.
  The DM thread is kept. **Delete** requires the exact name, archives, cancels runs, removes the container (fails 503
  and leaves the bot archived if Docker can't, so no container is orphaned), deletes the bot's DM threads (group
  threads stay) and the row (cascades runs, sessions, memories…), and removes `data/bots/<id>` only when asked.
- **Duplicate** copies profile, instructions, engine/model and settings into a new bot named "<name> (copy)" with a
  fresh handle, DM thread, home and token, and no history.
- **Live:** new `bots.changed {botId, change}` event on `global`; the web invalidates bot lists and that bot's detail
  (not after `deleted`, where a refetch would only 404). Bot lists are keyed by archived filter
  (`queryKeys.botList(f)`); `bot.status` patches every cached list.
- **UI:** `/bots` grid (Active/Archived tabs, quick actions Chat → DM thread, Computer → focuses that bot in the right
  panel via `openComputer(botId)`, Stop), `/bots/new` and `/bots/[id]` share `BotForm`, which validates with the
  runner's own zod schema and maps issues to fields. The sidebar lists non-archived, sidebar-visible bots (link →
  DM thread) and pins the lead when one exists. Form controls and the dialog are native elements
  (`<select>`, `<dialog>`), not Radix. `mock` is not offered in the engine picker (API only).
- **Embedded markdown headings are demoted** (`#` → `<h3>` …) so instruction previews and, later, chat messages never
  add a second page-level `<h1>`.
- **New dependencies:** `react-markdown` + `remark-gfm` (planned stack; no raw HTML rendering). shiki arrives with F13.
- **E2E bot homes live in `data/e2e/bots`** (`AGENTA_BOTS_DIR`/`AGENTA_SHARED_DIR` in playwright.config.ts) so bots
  created by tests never land in the owner's `data/bots`.

## F13 — Direct chat (session 1)
- **Thread API:** `GET /api/threads/:id` (thread + member `BotView`s), `GET /api/threads/:id/messages?before=&limit=`
  (chronological page + `hasMore`, fetched as limit+1), `POST /api/threads/:id/messages` → user message, one `user`
  run per addressed bot (DM: its bot), `{ message, runs }`. The user message's `run_id` points at the run it started;
  it is published (`message.created`) only after that link is set. Group threads store the message but start no runs
  until F18's @mention routing. `last_seen_message_id` is recorded keeping the session's stored engine (a session id
  must never be resumed by another engine).
- **Attachments are uploaded first, then referenced by name.** `POST /api/bots/:id/inbox?name=` takes raw bytes
  (`application/octet-stream`, scoped parser, 10 MB limit; Next's rewrite proxy passes 9.5 MB fine) into
  `data/bots/<id>/home/work/inbox/`, sanitising the name (last segment, no control chars, no leading dots) and never
  overwriting (`notes-1.txt`, exclusive create). No multipart dependency. The stored message ends with
  `📎 \`inbox/<name>\``; the prompt lists `/home/bot/work/inbox/<name>`. Sending validates the names still exist.
- **Live messages carry `authorType` + `createdAt`** (additive, optional) so the web inserts them into the cached
  pages without refetching every page of the infinite query.
- **Transcript = messages + runs.** The web fetches the thread's recent runs (`GET /api/runs?threadId=`, 100) and
  shows each run right after the user message that started it (a limit retry after its original), owning its reply.
  Active runs follow `run:<id>` (replayed from seq 0, so a reload mid-run shows everything streamed so far) and
  render deltas until finished; then the stored reply is shown. Inline states: Queued / Limited — resumes at HH:MM
  (queued + engine paused) / Working… / Stopped / Failed: … / Usage limit reached.
- **Virtualisation via `content-visibility: auto`** instead of a virtual list library: chat rows have dynamic,
  streaming heights and the list pages upward; the browser skips off-screen layout/paint without a dependency and
  without breaking scroll anchoring. Older pages load at the top with the scroll position restored.
- **shiki** (new dep) is loaded on first code block (dynamic import), dual light/dark themes via CSS variables;
  unknown fence languages render as `text`. Plain code shows until highlighting is ready.
- **Playwright runs with one worker:** specs share the runner's global run cap and the mock engine's limit pause.

## F13 — Direct chat (session 2)
- **Finished turns render from their stored events, not just the reply message.** `GET /api/runs/events?ids=a,b`
  (≤ 50 ids) returns each run's timeline compacted (`compactRunEvents`: consecutive `text.delta`s merged, tool output
  cut at 64 KB); the web batches every visible turn's request made in the same tick into one call
  (`createRunEventsLoader`) and caches them forever (finished runs don't change). A turn watched live to its
  `run.finished` keeps its live copy. This also keeps the partial text of stopped runs, which is never stored as a
  message. The reply message stays the source for copy/prompt history and is the fallback when events are missing.
- **Timeline model** (`lib/timeline.ts`): text, thinking, tool (call + result by callId), error and system blocks in
  event order, plus file changes (latest change per path). A `text.final` that matches the streamed deltas (ignoring
  whitespace) keeps the streamed layout, so text written around tool calls stays interleaved; a differing final
  replaces the draft; finals with no deltas (Codex) are appended.
- **Tool labels** (`lib/tools.ts`) cover Claude Code (Bash/Read/Write/Edit/MultiEdit/Glob/Grep/WebFetch/WebSearch/
  TodoWrite/Task), Codex (`shell`, `apply_patch` with its changed paths, `web_search`), Playwright MCP (`browser_*` →
  "Opened a page"…), the platform MCP (`mcp__agenta__*` → "Created a task"…, unknown tools humanised) and other MCP
  servers ("github: Create issue"). Diffs are a small LCS line diff (falls back to removed+added past 400×400 lines);
  no diff dependency.
- **Thread prompts go through `buildPrompt`** (F07) instead of the raw text: a plain DM turn is still exactly the
  typed message, but Explain mode and unseen messages from others are now included. The bot's own replies are left out
  (they're in its engine session); a bot with no recorded turn gets only the new message, not the whole history.
- **Retry** = `POST /api/threads/:id/retry {runId}`: only the bot's latest, finished turn; the new run reuses the
  stored prompt and sets `retry_of_run_id` to the original turn so it renders under the same user message. Side
  effect: a manual retry that hits a usage limit is not auto-retried again (same rule as limit retries).
- **Edit and resend posts a new message** (the engine session already contains the old turn, so it can't be rewritten).
  `splitUserMessage` recovers text and attachments from the stored message so the files don't need re-uploading.
- **Unread counts are server-side:** migration 0002 adds `threads.last_read_at` (not in PLAN's column list).
  `POST /api/threads/:id/read` (never moves backwards), `GET /api/threads/unread` counts bot/system messages after it.
  New messages publish a content-free `thread.activity` on `global`; the sidebar refetches counts. The open chat marks
  itself read on open, on each new message and when the tab becomes visible.
- **File chips → Files tab:** shell context gained `openFile(botId, path)` / `computerFilePath`; F15's Files tab opens
  that path (the placeholder shows it for now). Deleted files' chips are disabled.

## F14 — Live terminal
- **Deps:** `@xterm/xterm@6`, `@xterm/addon-fit`, `@xterm/addon-web-links` (web). xterm 6 because the current fit /
  web-links addons target it. Loaded with dynamic `import()` in an effect (xterm touches `window`).
- **Docker keeps a TTY exec running after the client hangs up** (verified: `bash -l` and a background `sleep` survived
  destroying the attach stream). So every terminal exec gets `AGENTA_TERMINAL=<trm_id>` in its environment and, on
  disconnect, `ContainerManager.killTerminal` runs `sh` as `bot` that HUPs then (1 s later) KILLs every process whose
  `/proc/<pid>/environ` holds that marker: the shell and everything it started. It never starts a stopped computer.
- **Protocol:** `/ws/terminal/:botId?cols=&rows=`; output = binary frames, everything else = JSON text frames
  (`input`, `resize` / `starting`, `ready`, `exit`, `error`), zod schemas in `packages/shared/src/terminal.ts`.
  Same Origin allow-list as `/ws`. Max 8 terminals per bot. Output pauses while >1 MiB waits in the socket buffer.
  `@fastify/websocket` is now registered once in `buildServer` for both `/ws` and `/ws/terminal`.
- **No automatic reconnect:** a new connection is always a new shell (PLAN), so silently reconnecting would swap the
  shell under the owner. A dropped/exited terminal shows "New shell" instead, in the same xterm (history kept).
- **Terminals are opened explicitly** ("Open terminal" button, `+` for more tabs) rather than on showing the tab,
  because opening one starts the bot's computer. All shells stay mounted (hidden) across computer-tab and bot switches
  while the panel is open; closing a tab or the panel ends them.
- **`USER`/`LOGNAME=bot` are set on the exec:** Docker sets `HOME` for the exec user but not `USER`.
- **Terminal theme is always dark** (CLI colour schemes assume it), in both app themes.
- **e2e bot homes on the VM disk:** `scripts/vm-mounts.sh` also bind-mounts `data/e2e/bots` and `data/e2e/shared`
  (the virtiofs project mount has no symlinks, which bot homes require), so e2e can start real bot computers.

## F15 — Files & shared workspace
- **Deps:** `@monaco-editor/react@4` + `monaco-editor@0.57` (web), the stack's editor. Monaco's AMD build is served
  by the app itself (`app/monaco/vs/[...path]/route.ts` reads `node_modules/monaco-editor/min/vs`) and the loader is
  pointed at `/monaco/vs`: the default jsDelivr CDN is blocked in the sandbox and the app should work offline.
  No copy step, nothing generated into `public/`.
- **API shape:** paths are root-relative (`root=home|shared`, `path=work/a.txt`), not container paths, under
  `/api/bots/:id/files*` (list, `content` GET/PUT, `raw`, `upload`, `mkdir`, `rename`, DELETE). The team share is
  reached through any bot. `locateContainerPath` maps chip paths (`/home/bot/…`, `/shared/…`) to these.
- **Path safety:** `..` and absolute paths are refused outright (not normalised away). Every operation realpaths the
  parent folder (and, when following, the target) and checks it stays under the root's realpath, so symlinked files
  or parent folders pointing outside are refused; links themselves can still be listed/renamed/deleted. TOCTOU
  symlink swaps are out of scope for a single-user local tool.
- **Raw bytes never render as HTML on the app origin:** only images and PDFs are served inline; everything else is
  `application/octet-stream` + `attachment`, with `nosniff`. SVG gets `CSP: sandbox`.
- **Save conflicts:** saves send the `modifiedAt` the file was opened at; a newer file on disk → 409
  `modified_elsewhere` and the viewer offers Reload (bots edit files concurrently).
- **Live refresh:** API changes and engine `file.changed` events publish `files.changed` (home → `bot:<id>`, share →
  `global`). Shell-made changes have no event, so open folders also re-list every 5 s while the tab is visible.
- **Upload limit 50 MB;** Next's rewrite proxy cuts bodies at 10 MB by default, so `next.config.ts` sets
  `experimental.proxyClientMaxBodySize: '51mb'` (verified: a 30 MB upload/download round-trips byte-identical).
- **Noise folders** (`node_modules`, `.cache`, `.npm`, `.pnpm-store`, `__pycache__`, `.venv`, `.local`, `.git`) are
  flagged by the runner and hidden behind a toggle (persisted in localStorage). Other dotfiles stay visible.
- **Files tab mounts on first visit and stays mounted** while the panel is open, so an unsaved edit survives tab
  switches. `/shared/{knowledge,decisions,handoff,projects}` are created at runner start and before a container starts.

## F16 — Browser & live desktop (session 1)
- **Desktop proxy is a plain WS-to-WS bridge** to the container's websockify (published on 127.0.0.1 in the VM), using
  Node 22's global `WebSocket` client, so no new runner dependency. The browser never sees the container port.
  View-only is enforced by the noVNC client only (parsing RFB in the runner to drop input is not worth it for a
  single-user, localhost app); the socket has the same origin check as the terminal.
- **New web dependency `@novnc/novnc@1.7.0`** (the RFB client the plan names). 1.7.0, not 1.6.0: 1.6.0's CommonJS
  `lib/` contains top-level await and does not bundle. Types are a small local `types/novnc.d.ts`.
- **Desktop mounts only while its tab is shown.** A watched desktop holds a container lease (no idle stop); leaving the
  tab disconnects so an unwatched computer can still idle-stop.

## F16 — Browser & live desktop (session 2)
- **One Playwright MCP definition for both engines** (`engines/mcp-config.ts`). The per-bot profile is passed as
  `--user-data-dir /home/bot/.browser-profile` on the command line (it overrides the image config), so existing images
  get it without a rebuild. Runs are one-per-bot, so the profile lock is never contended by the bot itself.
- **The runner writes `/home/bot/.agenta/mcp.json` now** (Playwright only, other servers preserved) instead of waiting
  for F17, so Claude bots get the browser today. F17 adds the `agenta` server to the same file.
- **Screenshot = ImageMagick `import -window root` on :99** (already in the image), saved under `~/screenshots/` so it
  shows in Files. A stopped computer is not started for it (409): its screen would be empty.
- **Chromium trusts the sandbox proxy CA through the bot's NSS db**, filled by the entrypoint with `certutil`
  (`libnss3-tools`, new image package, its own layer to keep the large layers cached). Not
  `--ignore-certificate-errors`: that would also hide real certificate problems.

## F17 — Platform MCP server (session 1)
- **New dependency `@modelcontextprotocol/sdk`** (runner; the stack's MCP library) for the Streamable HTTP server.
- **Stateless server, own `node:http` listeners.** Each request builds an `McpServer` bound to the token's bot, so no
  MCP sessions to track and identity can't leak between bots. One `http.Server` per address: 127.0.0.1 and the
  `agenta-net` gateway (DECISIONS F05), never 0.0.0.0. Port `AGENTA_MCP_PORT` (default 3002).
- **Token lookup by hash** (`bots.getByMcpTokenHash`): the token is 256 random bits, so indexing its SHA-256 is safe and
  needs no constant-time loop over bots. Archived bots are rejected.
- **Rate limit:** fixed window, 120 requests per minute per bot, 429 with `Retry-After`. In memory; resets on restart.
- **Token in `mcp.json`** (Authorization header, file mode 600), not an env var: both engines read it from that one
  file (Codex via the existing TOML translation), and the token file next to it is already readable by the bot.
- **Tool calls are logged by the engines' own `tool.call` events** on the calling run (Claude and Codex already emit
  `mcp__agenta__*`); the runner adds an info log per call (inputs at debug). The calling run = the bot's `running` run
  (a bot runs one turn at a time); `ask_bot` uses it as parent run and hop count + 1.
- **ask_bot default thread = the target's DM with the owner** (the owner watches there); other threads need both bots as
  members. The ask message is a bot message mentioning the target, with no `run_id` (a bot message's run id marks the
  reply of that run). Prompts name any bot author, not just members.
- **read_thread / post_message: members only.** post_message starts no runs; @mention routing is F18.
- **search_memory:** keyword scoring over the bot's own + shared memories (`shortcut:` comment; F22 may use FTS).
- **Mock engine uses the same `PlatformTools` in-process** (`MockPlatform.call(name, input, botId)`), so
  `[mock:delegate]` exercises the real tools without HTTP.

## F17 — Platform MCP server (session 2)
- **Task permissions:** a specialist's `create_task` defaults to itself and may not name another assignee; sub-tasks
  only under tasks assigned to it. The lead may create unassigned tasks or assign anyone. `update_task` (assignee,
  creator or lead) can only set todo / in_progress / blocked: `in_review` comes from `submit_task_result` (assignee or
  lead) and done / changes_requested only from `review_task` (lead, task must be in_review). Done tasks are frozen.
- **task_events** written by the tools: created, status (from/to), note, submitted (summary, artifacts, run),
  reviewed (verdict, feedback), decision. Actor = bot id.
- **Reviews and approvals don't start runs.** Re-triggering the assignee after review is the delegation loop (F20);
  bots poll `check_approval`. `request_approval` and `notify_owner` create notification rows (live delivery: F27).
- **add_lesson source:** `task` with a task id, else `run` with the calling run, else `manual`.


## F18 — Group chats & @mentions (session 1)
- **Thread columns:** `purpose` (text, default '') and `moderator_bot_id` (nullable, no FK) added to `threads`
  (migration 0003). A stale or removed moderator falls back to the default: Agent A (lead) if a member, else the
  first member. Removing the moderator from the group resets it to the default.
- **Mention syntax:** `@slug`, case-insensitive, at a word start; mentions inside code (inline or fenced) and on quoted
  (`>`) lines are ignored, so quoting a message never re-summons its mentions. One parser (`parseMentions` in
  `packages/shared`) is used for owner messages, bot replies and `post_message`.
- **Bot-to-bot routing:** a finished, succeeded reply is routed through `RunService.onReply` (a property set in
  `index.ts`, avoiding a constructor cycle with ThreadService); `post_message` routes too. Trigger `mention`,
  `hop_count` = parent + 1, never the author itself. A plain `MAX_HOPS = 6` cutoff is in place already (no runs past
  it); the system message, debounce and pause are session 2.
- **Mock echo quotes multi-line prompts** (`> ` per line) so a group turn's echo doesn't @mention everyone again.
  `[mock:moderate]` hands the message to the first other member via `ask_bot` (only when the prompt says the bot
  moderates); its reply text has no `@`, so it doesn't start a second turn.
- **Group attachments:** not offered in groups (the composer's paperclip is DM-only); attachments go to one bot's inbox.
- **Member changes** post a system message ("X joined/left the group."); the web invalidates the thread and group list
  on system-message activity, so other tabs see new members without a new live event type.

## F18 — session 2 (loop guards)
- **Hop limit:** `MAX_HOPS` = 6, overridable with the `maxHopsPerMessage` setting. A blocked mention posts a system
  message ("Stopped: … limit of N bot-to-bot turns …"); `ask_bot` past the limit fails with `hop_limit` and posts the
  same message, in DMs too.
- **Debounce = merge into the queued turn:** a `mention`/`delegation` trigger for a bot whose bot-triggered turn in
  the same thread was queued ≤ 5 s ago appends "## Also new since this turn was queued" + the message to that run's
  prompt (`runs.updateQueuedPrompt`, only while still queued) instead of a second run. Owner-triggered turns are
  never merged (each owner message keeps its own turn in the transcript).
- **Pause group:** `threads.paused_at` (migration 0004). Pause cancels the thread's queued runs (running ones finish;
  the composer's Stop handles those), and while paused bot mentions start nothing and `ask_bot` into the group fails
  with `group_paused`. The owner's next message, or Resume, clears it. System messages record both.
- **Per-group notifications:** `threads.notifications` (`all|mentions|none`, the bots' enum). For now it filters the
  sidebar unread count: `mentions` counts system messages and messages containing `@owner` (group prompts tell bots
  to write `@owner` for the owner's attention); `none` mutes. F27 reuses the setting for the notification inbox.

## F19 — task board
- **Starting a task = a `task` run in the task's own thread.** Assigning a bot (create with an assignee, or a new
  assignee in PATCH) starts it unless `executedBy` is `human` or the task is done; `POST /tasks/:id/start` starts it
  again. The first start creates a `task` thread (title = task title) and adds the assignee; the owner's message
  ("Please start on this task." or the request-changes feedback) is posted there and the prompt carries the task brief
  (`buildPrompt` with the task). A task with a queued/running run refuses another start (`task_running`). Todo or
  blocked tasks move to in_progress on start. Task threads stay read-only in the chat UI.
- **Owner review endpoints:** `approve` (in_review → done) and `request-changes` (→ changes_requested, revision + 1,
  and the assignee's next turn starts with the feedback). F20 adds the lead's automated review on top.
- **Owner status changes are unrestricted** (drag & drop can move a task to any column); bots stay bound by the F17
  tool rules. Every owner change writes a `task_events` row with actor `user`.
- **Live:** one `task.changed {taskId}` event on `global`, published by the task service and by every Platform MCP
  task tool (via its `event()` helper). The web invalidates all `['tasks']` queries on it.
- **Filters are client-side** (`GET /api/tasks` returns every task): fine for one owner's board.
- **Drag & drop uses native HTML5 DnD** (no new dependency); the drawer's status select is the keyboard alternative.
- Mock engine `[mock:task]`: in a task turn, adds a note (`update_task`) and hands in a result
  (`submit_task_result`, artifact `/shared/mock-result.md`).

## F20 — Agent A delegation loop
- **`goals` table (migration 0005), not in PLAN's table list:** a goal holds the owner's text, constraints, auto-run
  flag, guardrails (`max_tasks` 12, `max_runs` 40), the lead, its thread and the report run. `tasks.goal_id` and
  `runs.goal_id` tie work to it, so progress and the run budget are plain counts.
- **New thread kind `goal`:** the goal's conversation with the lead (plan, confirmation, reviews, report). The owner's
  messages there go to the lead like a DM, and every turn's prompt carries the goal (text, constraints, artifacts
  folder `/shared/projects/<slug>/`, and the plan status: waiting for confirmation / create the tasks now / progress).
  The planning protocol is added to the lead's system prompt only in goal threads.
- **Goal of a run is derived in `RunService.enqueue`** (explicit, else the task's, the goal thread's, or the parent
  run's), which is also the single guard: a paused goal or one at its run budget refuses new runs (`goal_paused`,
  `goal_run_limit`). Senders check first (`admitGoal`) so nothing is posted when the run would be refused.
- **Confirmation is enforced, not just asked for:** until the owner clicks Confirm plan (or auto-run is on),
  `create_task` from the lead in a goal turn fails with `plan_not_confirmed`; it also enforces `max_tasks`. Confirm
  posts "I confirm the plan…" in the goal thread, which starts the lead's turn.
- **The lead's goal tasks start on creation** (task thread + brief with goal context). Other `create_task` calls keep
  the F17 behaviour (not started).
- **Review = a `review` run of the lead in the goal thread** with the task id, queued when a goal task is handed in
  (the lead's own tasks are left to the owner). `review_task` request_changes now restarts the assignee with the
  feedback (any task, like the owner's request-changes), queued behind its still-finishing turn. A third request
  after `MAX_REVISION_ROUNDS` = 2 is refused as an escalation: the task stays in review, a `escalated` task event and a
  notification ask the owner to decide.
- **Goal report:** the GoalService listens to `task.changed`; when every goal task is done it queues the lead's report
  run (trigger `review`) and marks the goal `reporting`; the report run's reply marks it `done` (+ notification).
  The report prompt asks for `record_decision` / `add_lesson` calls.
- **Pause** cancels the goal's queued runs (running ones finish) and blocks new ones; **Resume** restarts assigned
  tasks with no turn, re-queues missing reviews (not escalated ones) and re-runs a report that never finished.
- **Owner-visible blockers:** when a review or the report can't start (budget, missing lead) a system message in the
  goal thread and a `goal.blocked` notification say why.
- **Mock `[mock:plan]`:** Agent A's whole side picked from the prompt: review (requests changes once on a task whose
  title says "rework"), report (`record_decision` + `add_lesson`), task turn, create 3 tasks round-robin over the
  non-lead bots once confirmed, otherwise propose a plan. The goal text carries the keyword into every goal turn.
- **UI:** Home has the New goal form (goal, constraints with the non-confidential hint, auto-run) and goal cards with
  progress bar and budget (tasks, runs); goal threads get a bar with status, progress and Confirm / Pause / Resume.
  Ctrl+K → "New goal" focuses the form. Goal queries refetch on `goal.changed`, `task.changed` and `run.updated`.
- **E2E lead:** the e2e DB has no seeded team until F21, so `goals.spec.ts` inserts a mock lead (and a specialist)
  straight into `data/e2e/agenta.db` through `@agenta/db`.

## F21 — Agent A team templates & skills
- **Template format:** `templates/team/team.json` (bots: slug, name, role, engine, lead flag, avatar, skills; the group),
  `bots/<slug>.md` (instructions) and `skills/<name>/SKILL.md` (Claude Code skill format, `name` + `description` front
  matter). Loaded and validated by `@agenta/db` (`loadTeamTemplate`: exactly one lead, every skill exists).
- **Seed:** `pnpm db:seed` now creates the 7-bot team, a DM per bot and the "Lead Room" group (all members, Agent A
  moderates), idempotently by slug. The Echo Bot seed (`seedDb`) stays as a test helper only.
- **Skills live in `bots.settings.skills`** (optional list of skill names), so they survive renames and can be edited
  through the existing PATCH. Unknown names are ignored when rendering.
- **Rendering:** before each real-engine run and when a computer starts (`prepareHome`), the runner copies the bot's
  skills to `~/.claude/skills/<name>/` (marked `.agenta-managed`; unmarked, hand-made skills are never touched,
  ours that the bot no longer has are removed). CLAUDE.md lists the skills (Claude Code loads them itself); AGENTS.md
  carries their full text for Codex, as PLAN.md asks.
- **Reset team to defaults** (`POST /api/team/reset`, Settings → Team): recreates missing team bots and the Lead Room;
  for existing team bots (archived ones are restored) it restores role, instructions, skills and the lead flag, and
  makes Agent A the only lead. Names, engines, models, avatars, resource limits and all data are kept. The Lead Room
  is found by title; a renamed one gets a new Lead Room on reset.
- **No auto-seed on runner start:** first-launch seeding is `pnpm db:seed` now and the onboarding wizard in F31, so
  e2e specs that expect an empty team keep working.

## F22 — Memory system
- **Search is SQLite FTS5** (`memories_fts`, external content over `memories`, porter + unicode61, synced by triggers).
  Query words are quoted and prefix-matched, joined by OR, ranked by bm25 with the title weighted ×2. No embeddings.
- **Secret check lives in `@agenta/shared/guard.ts` (`findSecrets`)** so F24 can grow it into the full confidentiality
  guard (emails, IPs, internal hosts, guard terms). Memory saves only reject secrets (keys, tokens, private keys,
  credential assignments, high-entropy strings ≥32 chars, >4.3 bits/char with mixed case and digits: hex hashes and
  UUIDs pass). Rejections return 422 `secret_detected` and never echo the matched text.
- **Rendering budget:** pinned memories first, then newest (own and shared together), until 2,000 words; the memory
  crossing the cap is cut to the words left (if ≥20) and nothing follows. New `memories.pinned` column.
- **Shared mirror is one-way (DB → `/shared/knowledge/<id>-<slug>.md`).** The DB is the source of truth; files whose
  name does not start with a memory id are never touched, so bots can still keep their own notes there. A failed
  mirror write is logged, not fatal.
- **All writes go through `MemoryService`** (owner API and bots' `save_memory`), so the guard, mirror and live
  `memory.changed` event apply to both.
