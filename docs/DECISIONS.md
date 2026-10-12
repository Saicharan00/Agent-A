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
