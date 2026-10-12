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
