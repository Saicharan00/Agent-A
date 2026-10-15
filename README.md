# Agent A

A local, single-user platform of AI "teammates". Each bot gets its own sandboxed computer, and the team is led
by **Agent A**, a Lead AI Engineer mentor.

> Work in progress. Full docs arrive in F34.

## Quick start (inside the Docker Sandbox)
```bash
pnpm install
cp .env.example .env.local   # optional; defaults work
pnpm dev                     # web on :3000, runner on :3001
```

## Commands
| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Run web + runner (dev / production) |
| `pnpm typecheck` · `pnpm lint` · `pnpm test` | Static checks and unit tests (Vitest) |
| `pnpm e2e` | Playwright tests against the mock engine |
| `pnpm check:secrets` | Fail if staged files contain secrets or `data/` paths |
| `pnpm run doctor` | Environment health check (`pnpm doctor` is a pnpm built-in) |
| `pnpm restore <backup folder>` | Stop the app and put a backup from `data/backups/` back (Settings → Backups lists them) |

See `docs/architecture.md` and `docs/DECISIONS.md`.
