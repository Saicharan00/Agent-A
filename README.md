# Agent A

A local, single-user platform of AI "teammates". Each bot has its own sandboxed computer (a Docker container with a
terminal, a browser, a desktop and files), and the team is led by **Agent A**, a Lead AI Engineer mentor. Agent A plans
your goals, delegates to specialist bots, reviews their work, asks before anything risky, and explains how a strong
lead thinks along the way.

The bots run on **your own subscriptions** through the official CLIs: Claude Code (Claude Pro/Max) and Codex
(ChatGPT Plus/Pro). No API keys are needed.

Everything runs inside one **Docker Sandbox** (`sbx`) microVM on your machine: the web app, the runner, the database
and every bot computer. Nothing is installed on Windows except `sbx` and Git, and the app is never run on the laptop
directly.

```
Windows browser ── http://localhost:3000 ──▶ sbx sandbox "agent-a" (Linux VM)
                                              ├─ web (Next.js, :3000) ──/api──▶ runner (Fastify, :3001)
                                              │                                  ├─ SQLite  data/agenta.db
                                              │                                  ├─ Platform MCP server (:3002)
                                              └─ private Docker daemon ◀─────────┘
                                                   └─ agenta-bot containers (one per bot): Claude Code / Codex,
                                                      terminal, Chromium + noVNC desktop, /home/bot, /shared
```

More detail: `docs/architecture.md` (how it fits together), `docs/engines.md` (CLI flags), `docs/SECURITY.md`,
`docs/DECISIONS.md` (why things are the way they are), `docs/DEMO.md` (a 15-minute tour).

---

## Requirements

- Windows 11 (or macOS/Linux) with hardware virtualization enabled in the BIOS.
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) CLI `sbx` (`winget install Docker.sbx`), signed in with
  `sbx login`. Git for Windows.
- About **25 GB** free disk for the sandbox (bot image ≈ 2 GB, dependencies and builds ≈ 3 GB, plus bot work).
- A Claude Pro/Max and/or ChatGPT Plus/Pro subscription for real bots. Without one, everything still runs on the
  built-in **mock engine** (used by the tests).

Inside the sandbox (set up once, step 4 below): Node 22 LTS, pnpm 10, and Docker (the sandbox ships its own daemon).

## Setup (once)

1. **Get the code** (Windows PowerShell):
   ```powershell
   git clone <repo url> E:\Agent-A-GrokBot
   cd E:\Agent-A-GrokBot
   ```
2. **Create the sandbox** with port 3000 published to your machine only:
   ```powershell
   sbx create --name agent-a -p 127.0.0.1:3000:3000 claude .
   ```
3. **Allow the network the build needs.** The sandbox blocks unknown domains. Allow these once:
   ```powershell
   sbx policy allow network --sandbox agent-a registry.npmjs.org,github.com,objects.githubusercontent.com,codeload.github.com,nodejs.org
   sbx policy allow network --sandbox agent-a registry-1.docker.io,auth.docker.io,production.cloudflare.docker.com,production.cloudfront.docker.com
   sbx policy allow network --sandbox agent-a deb.debian.org,cli.github.com,archive.ubuntu.com,security.ubuntu.com
   sbx policy allow network --sandbox agent-a api.anthropic.com,platform.claude.com,console.anthropic.com,claude.ai
   sbx policy allow network --sandbox agent-a chatgpt.com,api.openai.com,auth.openai.com
   ```
   If a command later fails with HTTP 403 "Approval required", run `sbx policy approval ls` and approve it, or allow
   the domain it names the same way. (`cdn.playwright.dev`, `playwright.download.prss.microsoft.com` and
   `storage.googleapis.com` are only needed to run the browser tests.)
4. **Prepare the sandbox** (once). Open a shell in it with `sbx exec -it agent-a bash`, then:
   ```bash
   cd /e/Agent-A-GrokBot                 # your project folder, as the sandbox sees it
   npm i -g pnpm@10
   # node_modules, .next and the bot homes must live on the VM disk (the Windows folder forbids symlinks):
   echo '[ -x /e/Agent-A-GrokBot/scripts/vm-mounts.sh ] && /e/Agent-A-GrokBot/scripts/vm-mounts.sh' | sudo tee -a /etc/sandbox-persistent.sh
   sh scripts/vm-mounts.sh
   cp .env.example .env.local
   ```
   Then edit `.env.local` and set `AGENTA_WEB_HOST=0.0.0.0`. The published port only reaches a server listening on
   the VM's network interface. The runner and the MCP server stay on 127.0.0.1 regardless, and the API rejects
   unknown hosts and cross-site writes (`docs/SECURITY.md`).
5. **Launch:** `pnpm launch` (see below). The first launch installs dependencies, builds the app and the bot image
   (~10 minutes), then prints `✔ Agent A is running: http://localhost:3000`.
6. **Open http://localhost:3000** on Windows. The first-run wizard checks Docker and the image, shows engine
   sign-in, and creates the team.
7. **Sign the bots in to your subscriptions** (in the sandbox shell; never paste tokens into a chat):
   - Claude: `pnpm auth:claude`. It runs `claude setup-token` in a throwaway container and saves the token to
     `.env.local`.
   - Codex: `pnpm auth:codex`. Open the link, enter the code. It saves `data/secrets/codex/auth.json`.

   Settings → Engines then shows both as **configured**.

## Daily use

| You want to… | Do this |
|---|---|
| Start Agent A | Double-click `scripts\windows\AgentA.cmd`, or in the sandbox run `pnpm launch` |
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

**`scripts/windows/AgentA.cmd`** starts the `agent-a` sandbox if it is stopped and runs `pnpm launch` in it in a new
window (`sbx exec`). It opens your browser when the app answers. Make a desktop shortcut to it if you like. If you
moved the project, edit `WORKDIR` at the top (`E:\X` is `/e/X` in the sandbox).

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
- **Copy off the machine:** `data/backups` is in your Windows project folder (`E:\Agent-A-GrokBot\data\backups`), so
  any Windows backup tool can pick it up.
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

Start with `pnpm run doctor`. It checks the sandbox VM, Node, pnpm, Docker, the image, disk, ports, the database
and engine sign-in, and says what to do for each failure.

| Symptom | Fix |
|---|---|
| http://localhost:3000 does not load on Windows, but `curl localhost:3000` works in the sandbox | Set `AGENTA_WEB_HOST=0.0.0.0` in `.env.local` and relaunch. Check `sbx ports agent-a` lists 3000. |
| `ENOSPC: no space left on device` | The sandbox disk is full. Check with `df -h /`. Free space with `docker image ls agenta-bot` (remove old tags), old backups in `data/backups`, and leftover `~/.cache/agenta-vm-*` dirs of deleted worktrees. |
| HTTP 403 "Approval required" / "Blocked by network policy" | A domain is not allowed. Run `sbx policy allow network --sandbox agent-a <domain>` on Windows, or approve it with `sbx policy approval ls`. |
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
3001, MCP 3002, all inside the sandbox. Data lives in `data/`: the database, bot homes, the team share, backups and
engine credentials. `data/` is never committed.
