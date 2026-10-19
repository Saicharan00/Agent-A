# Architecture

```
Windows browser ──http://localhost:3000──▶ apps/web (Next.js UI)
                                              │  REST (fetch) + WebSocket
                                              ▼
                                   apps/runner (Fastify, :3001, 127.0.0.1)
         ┌──────────────┬──────────────┬───────────────┬──────────────┬────────────┐
         │ Container    │ Run queue &  │ Platform MCP  │ Scheduler    │ Event bus  │
         │ manager      │ engine       │ server (:3002)│ (croner)     │ (WS fanout)│
         │ (dockerode)  │ adapters     │               │              │            │
         └──────┬───────┴──────┬───────┴───────▲───────┴──────────────┴────────────┘
                │ docker exec  │               │ HTTP (per-bot token) via host.docker.internal
                ▼              ▼               │
     ┌──────────────── bot container (agenta-bot:latest), one per bot ────────────────┐
     │ user `bot` (non-root) · /home/bot (bind: data/bots/<id>/home) · /shared (bind)  │
     │ claude CLI · codex CLI · node · python · git · gh · ripgrep · Playwright+Chrome │
     │ Xvfb :99 + fluxbox + x11vnc + websockify (noVNC on :6080 → 127.0.0.1:<random>)  │
     │ Playwright MCP (headed on :99) · Platform MCP client config                      │
     └─────────────────────────────────────────────────────────────────────────────────┘
                                   SQLite: data/agenta.db (Drizzle)
```

Everything above runs on one Linux machine with Docker. Two setups are supported: **native** (a Linux machine,
or a WSL2 distro on Windows, with Docker Engine; bot containers use that Docker daemon) and **Docker Sandbox**
(`sbx`, Windows/macOS: everything runs inside one microVM, and bot containers live in the VM's private Docker daemon).
The network-policy commands (`sbx policy allow …`) the app shows apply only to the sandbox setup.

## Repository layout
- `apps/web`: Next.js UI (App Router, Tailwind v4, shadcn/ui). Proxies `/api/*` to the runner.
- `apps/runner`: Fastify service (containers, runs, MCP, scheduler, websockets).
- `packages/shared`: zod schemas, shared types, constants, env loading (`@agenta/shared/env`, Node-only).
- `packages/db`: Drizzle schema, migrations, repositories (F02).
- `docker/bot`: bot computer image (F04).
- `scripts/`: repo tooling (`check-secrets.ts`, `doctor.ts`, `vm-mounts.sh`).
- `tests/e2e`: Playwright specs (mock engine). `tests/smoke`: real-engine smoke tests (`SMOKE=1` only).
