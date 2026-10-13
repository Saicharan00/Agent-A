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
