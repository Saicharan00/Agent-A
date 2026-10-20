# Agent A

A local, single-user platform of AI "teammates". Each bot has its own sandboxed computer (a Docker container with a
terminal, a browser, a desktop and files), and the team is led by **Agent A**, a Lead AI Engineer mentor. Agent A plans
your goals, delegates to specialist bots, reviews their work, asks before anything risky, and explains how a strong
lead thinks along the way.

The bots run on **your own subscriptions** through the official CLIs: Claude Code (Claude Pro/Max) and Codex
(ChatGPT Plus/Pro). No API keys are needed. Without a subscription, everything still runs on the built-in **mock
engine** (the one the tests use), so you can try the whole app first.

```
browser ── http://localhost:3000 ──▶ Linux machine (native, WSL2, or an sbx sandbox VM)
                                      ├─ web (Next.js, :3000) ──/api──▶ runner (Fastify, :3001)
                                      │                                  ├─ SQLite  data/agenta.db
                                      │                                  ├─ Platform MCP server (:3002)
                                      └─ Docker daemon ◀─────────────────┘
                                           └─ agenta-bot containers (one per bot): Claude Code / Codex,
                                              terminal, Chromium + noVNC desktop, /home/bot, /shared
```

More detail: `docs/architecture.md` (how it fits together), `docs/engines.md` (CLI flags), `docs/SECURITY.md`,
`docs/DECISIONS.md` (why things are the way they are), `docs/DEMO.md` (a 15-minute tour),
`docs/PROBLEMS-AND-FIXES.md` (problems hit while building real projects, and their fixes).

---

## Choose a setup

| Setup | Runs on | Pick it when |
|---|---|---|
| **A. Native** | Linux, or Windows through a WSL2 distro (Ubuntu) with Docker Engine installed inside it | You want the simplest setup. Bot containers run on your own Docker daemon. |
| **B. Docker Sandbox (`sbx`)** | Windows or macOS | You want everything, including the bots' Docker daemon, inside one isolated microVM. |

**Docker Desktop is not supported yet.** The bots reach the runner's MCP server through the Docker bridge's gateway
IP, which does not exist on a Docker Desktop host. On Windows, install Docker Engine inside WSL2 (setup A) or use
setup B. On macOS, use setup B.

Both setups need:

- About **25 GB** free disk (bot image ≈ 2 GB, dependencies and builds ≈ 3 GB, plus bot work).
- Outbound access to npm, GitHub, Docker Hub and Debian/Ubuntu mirrors for the first build, plus `api.anthropic.com`
  / `claude.ai` and `chatgpt.com` / `api.openai.com` for real engines.
- Optional: a Claude Pro/Max and/or ChatGPT Plus/Pro subscription for real bots.

## Setup A: native Linux or WSL2

1. **Install the tools** (Ubuntu/Debian shown; use your distro's equivalents):
   - Node **22 LTS** (e.g. via [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`), then `corepack enable` so the
     pinned pnpm is used.
   - Build tools for native modules: `sudo apt install -y build-essential python3 git`.
   - [Docker Engine](https://docs.docker.com/engine/install/). Add yourself to the `docker` group
     (`sudo usermod -aG docker $USER`, then log out and in) and check that `docker version` shows a server.
   - On WSL2: install Docker Engine **inside** the distro (not Docker Desktop's WSL integration).
2. **Check your user id:** `id -u` should print `1000`. The bot user in the containers is uid 1000 and bot homes are
   bind-mounted from `data/bots`, so a different uid makes the bots' home folders unwritable. The first user on most
   Linux and WSL installs is 1000.
3. **Get the code and configure:**
   ```bash
   git clone https://github.com/Saicharan00/Agent-A-GrokBot.git agent-a
   cd agent-a
   cp .env.example .env.local
   ```
   The defaults in `.env.local` are fine. Everything binds to `127.0.0.1`.
4. **Launch:** `pnpm launch`. The first launch installs dependencies, builds the app and the bot image
   (~10 minutes), then prints `✔ Agent A is running: http://localhost:3000`.
5. **Open http://localhost:3000.** On WSL2, your Windows browser reaches it at the same address. The first-run wizard
   checks Docker and the image, shows engine sign-in, and creates the team.
6. **Sign the bots in** (see below).

## Setup B: Docker Sandbox (`sbx`) on Windows or macOS

1. Install the [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) CLI `sbx` (Windows:
   `winget install Docker.sbx`), and sign in with `sbx login`. Install Git. Hardware virtualization must be enabled.
2. **Get the code** and open a terminal in the project folder:
   ```bash
   git clone https://github.com/Saicharan00/Agent-A-GrokBot.git agent-a
   cd agent-a
   ```
3. **Create the sandbox** with port 3000 published to your machine only. The examples use the name `agent-a`;
   any name works.
   ```bash
   sbx create --name agent-a -p 127.0.0.1:3000:3000 claude .
   ```
4. **Allow the network the build needs.** The sandbox blocks unknown domains. Allow these once:
   ```bash
   sbx policy allow network --sandbox agent-a registry.npmjs.org,github.com,objects.githubusercontent.com,codeload.github.com,nodejs.org
   sbx policy allow network --sandbox agent-a registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,production.cloudfront.docker.com
   sbx policy allow network --sandbox agent-a deb.debian.org,cli.github.com,archive.ubuntu.com,security.ubuntu.com
   sbx policy allow network --sandbox agent-a api.anthropic.com,platform.claude.com,console.anthropic.com,claude.ai
   sbx policy allow network --sandbox agent-a chatgpt.com,api.openai.com,auth.openai.com
   ```
   If a command later fails with HTTP 403 "Approval required", run `sbx policy approval ls` and approve it, or allow
   the domain it names the same way. (`cdn.playwright.dev`, `playwright.download.prss.microsoft.com` and
   `storage.googleapis.com` are only needed to run the browser tests.)

   **When a bot asks for access to a site** (for example `pypi.org` and `files.pythonhosted.org` to install Python
   packages), allow it from your machine's terminal, not from the app or the sandbox shell:
   ```bash
   sbx policy allow network --sandbox agent-a pypi.org,files.pythonhosted.org
   ```
   Replace the domains with the ones the bot names. No restart is needed; the bot's next try gets through.
5. **Prepare the sandbox** (once). Open a shell in it with `sbx exec -it agent-a bash`, then go to your project
   folder as the sandbox sees it (on Windows, `E:\code\agent-a` is `/e/code/agent-a`):
   ```bash
   cd /path/to/agent-a
   npm i -g pnpm@10
   # node_modules, .next and the bot homes must live on the VM disk (host folders forbid symlinks):
   echo "[ -x $PWD/scripts/vm-mounts.sh ] && $PWD/scripts/vm-mounts.sh" | sudo tee -a /etc/sandbox-persistent.sh
   sh scripts/vm-mounts.sh
   cp .env.example .env.local
   ```
   Then edit `.env.local` and set `AGENTA_WEB_HOST=0.0.0.0`. The published port only reaches a server listening on
   the VM's network interface. The runner and the MCP server stay on 127.0.0.1 regardless, and the API rejects
   unknown hosts and cross-site writes (`docs/SECURITY.md`).
6. **Launch:** `pnpm launch` in the sandbox shell (~10 minutes the first time), then open http://localhost:3000 on
   your machine. On Windows, `scripts\windows\AgentA.cmd` does both (see Daily use).
7. **Sign the bots in** (below, in the sandbox shell).

## Sign the bots in

In the project folder (the sandbox shell for setup B). Never paste tokens into a chat.

- Claude: `pnpm auth:claude`. It runs `claude setup-token` in a throwaway container and saves the token to
  `.env.local`.
- Codex: `pnpm auth:codex`. Open the link, enter the code. It saves `data/secrets/codex/auth.json`.

Settings → Engines then shows both as **configured**. You can skip this and use the mock engine.

## Daily use

| You want to… | Do this |
|---|---|
| Start Agent A | `pnpm launch` (setup B on Windows: double-click `scripts\windows\AgentA.cmd`) |
| Open it | http://localhost:3000 |
| Stop it | Ctrl+C in the launch window (bot computers stop on their own when idle) |
| Check health | `pnpm run doctor` (or Settings → Health). Note: `pnpm doctor` is a pnpm built-in. |
| Give the team work | Home → **New goal** → **Start goal** → read the plan → **Confirm plan** |
| Talk to one bot | Click it in the sidebar. **Computer** opens its terminal, files, desktop and runs. |
| Answer approvals | Home → **Waiting for your approval** (also in Notifications) |
| Learn from it | Learn → Decisions, Lessons, Work split, Briefs, **Weekly review** |

`pnpm launch` does, in order: install dependencies → build the web app if the code changed since the last build →
migrate the database → build the bot image if it does not exist → start web + runner in production mode → print the
URL once both answer. If the app is already running it just prints the URL. `pnpm launch -- --rebuild` forces a new
web build.

**`scripts/windows/AgentA.cmd`** (setup B) starts the sandbox if it is stopped and runs `pnpm launch` in it in a new
window (`sbx exec`). It opens your browser when the app answers. It finds the project folder from its own location;
set `AGENTA_SANDBOX` if your sandbox is not named `agent-a`, or `AGENTA_WORKDIR` to override the folder.

### Developer commands
| Command | What it does |
|---|---|
| `pnpm dev` | Web (:3000) + runner (:3001) with hot reload |
| `pnpm build` / `pnpm start` | Production build / start (what `pnpm launch` uses) |
| `pnpm typecheck` · `pnpm lint` · `pnpm test` | Static checks and unit tests (Vitest) |
| `pnpm e2e` | Playwright tests on the mock engine (never your subscriptions) |
| `pnpm check:secrets` | Fail if staged files contain secrets or `data/` paths |
| `pnpm db:migrate` · `pnpm db:seed` | Database migrations (also run on every runner start) / demo data |
| `pnpm image:build` | Build the bot computer image `agenta-bot:latest` |
| `pnpm restore <backup folder>` | Put a backup back (see Backups) |
| `SMOKE=1 pnpm smoke:<auth\|claude\|codex\|browser\|github\|mcp>` | One short real-engine check (uses your subscription) |

## How limits work

Bots use your subscriptions, which have rolling usage windows (e.g. Claude's 5-hour limit).

- **When an engine hits its limit**, the run is marked *limited*. Agent A pauses that engine until the reset time the
  CLI reported, and a notification tells you when. Queued work waits and resumes by itself; goals keep their place.
- **Daily run budget** (Settings → Usage, per engine): runs started in the last 24 hours. You are warned at 80 %.
  With **hard stop** on, new runs wait in the queue until the window frees (they never fail).
- **Concurrency** (1–8 runs at once) caps how hard you lean on a subscription.
- **Per-goal budget:** each goal has a maximum number of runs; Agent A stops and asks when it is used up.
- The **Usage** page shows runs per day, per bot and per engine, and every limit hit with its reset time.

## Backups

- **Automatic:** a daily backup at the first launch of the day (checked hourly), keeping the newest 7.
- **Manual:** Settings → Backups → **Back up now**.
- Each backup is a folder in `data/backups/<time>/`: the database (consistent copy), the team share and the bot homes.
  It **never** includes `.env.local`, `data/secrets/` or login files inside bot homes, so copy those yourself if you
  move machines.
- **Restore:** stop nothing by hand. Run `pnpm restore data/backups/<time>`. It stops the app and bot computers, saves
  the current data as a `pre-restore` backup, then puts the backup back. Run `pnpm launch` afterwards.
- **Copy off the machine:** `data/backups` is inside the project folder, so any backup tool that covers that folder
  picks it up. (Setup B on a host folder: it is on the host disk.)
- **Export to Markdown:** a thread (thread header), a goal report (goal bar), decisions and lessons (Learn).
- **Factory reset:** Settings → Backups → Factory reset, type `RESET`. It backs up first and keeps engine sign-ins.

## Updating

- **The app:** `git pull`, then `pnpm launch` (it reinstalls and rebuilds what changed).
- **The bot image** (new Claude Code / Codex CLI versions, or after `docker/bot` changes): `pnpm image:build`
  (or Settings → **Build image**). Then reset each bot's computer (bot page → Reset) so it uses the new image. Bot
  homes are kept. `pnpm run doctor` warns when the image is older than `docker/bot`.
- CLI flags change between versions. If runs fail after an image update, compare `claude --help` / `codex exec --help`
  in a bot terminal with `docs/engines.md`.

## Troubleshooting

Start with `pnpm run doctor`. It checks where it runs (sandbox or native), Node, pnpm, Docker, the image, disk,
ports, the database and engine sign-in, and says what to do for each failure.

| Symptom | Fix |
|---|---|
| `docker version` shows no server, or "permission denied" on the Docker socket | Start Docker Engine (`sudo service docker start` on WSL2) and make sure you are in the `docker` group. |
| Bots cannot write their home folder | Your uid is not 1000 (`id -u`). Run Agent A as a uid-1000 user. |
| Setup B: http://localhost:3000 does not load on the host, but `curl localhost:3000` works in the sandbox | Set `AGENTA_WEB_HOST=0.0.0.0` in `.env.local` and relaunch. Check `sbx ports <sandbox>` lists 3000. |
| `ENOSPC: no space left on device` | The disk is full. Check with `df -h /`. Free space with `docker image ls agenta-bot` (remove old tags), old backups in `data/backups`, and leftover `~/.cache/agenta-vm-*` dirs. |
| Setup B: HTTP 403 "Approval required" / "Blocked by network policy" | A domain is not allowed. Run `sbx policy allow network --sandbox <sandbox> <domain>` on the host, or approve it with `sbx policy approval ls`. |
| Engine shows **not set up** | Run `pnpm auth:claude` / `pnpm auth:codex`, then Settings → Engines → Re-check. |
| A bot's runs end as *limited* | Its subscription window is used up. See "How limits work". It resumes by itself. |
| Bot computer won't start / "image missing" | `pnpm image:build`, then reset the bot's computer. |
| `pnpm launch` says it is already running, but the page is broken | Something else holds port 3000. Run `ss -ltnp \| grep 300`, stop it, relaunch. |
| Page looks stale after an update | `pnpm launch -- --rebuild` |
| `pnpm doctor` prints pnpm's own help | Use `pnpm run doctor`. |
| Something is badly wrong | `pnpm restore` a recent backup, or Settings → factory reset (backs up first). |

Logs go to the launch window (pino, `LOG_LEVEL` in `.env.local`). Prompts and secrets are never logged at `info`.

## Configuration

All settings live in `.env.local` (git-ignored; template and comments in `.env.example`). Ports: web 3000, runner
3001, MCP 3002, all on `127.0.0.1`. Data lives in `data/`: the database, bot homes, the team share, backups and
engine credentials. `data/` is never committed.

## Security notes

Agent A has **no login**: whoever can reach port 3000 controls the bots. Keep it bound to `127.0.0.1` and do not
expose it to a network. Bots run real commands in their containers with your subscriptions; review approvals before
you accept them. See `docs/SECURITY.md`.

## License

MIT. See `LICENSE`.
