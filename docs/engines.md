# Engines: observed CLI behaviour

Recorded from inside `agenta-bot:latest` (F04, 2026-10-12). **Code against this file, not PLAN.md's guesses.**
Re-check after bumping engine versions (`docker run --rm agenta-bot:latest claude --help`, etc.).

| Tool | Version observed |
|---|---|
| Claude Code (`@anthropic-ai/claude-code`) | 2.1.296 |
| Codex CLI (`@openai/codex`) | codex-cli 0.162.1 |
| Playwright MCP (`@playwright/mcp`) | 0.0.83 (Playwright 1.64.0-alpha-1790635538000, Chromium 155.0.8059.12) |
| GitHub CLI | 2.102.0 |
| Python | 3.11.2 |

## Claude Code (`claude`)

Usage: `claude [options] [command] [prompt]`. Interactive by default; `-p/--print` for non-interactive.
There is no separate `claude -p --help`: the print-mode flags are in the main help, marked "only works with --print".

Flags relevant to the adapter (F08):
- `-p, --print`: non-interactive; prompt as the positional argument (or stdin). Skips the workspace trust dialog.
- `--output-format text|json|stream-json`: `stream-json` gives realtime JSONL events (print mode only).
- `--input-format text|stream-json`: streaming input (print mode only).
- `--include-partial-messages`: partial message chunks as they arrive (→ `text.delta`); needs `--print` + `stream-json`.
- `--verbose`: verbose mode (historically required with `-p --output-format stream-json`; verify in F08).
- `-r, --resume [sessionId]`, `-c, --continue`, `--session-id <uuid>` (we can choose the id up front), `--fork-session`.
- `--dangerously-skip-permissions`; `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`;
  `--permission-prompts host|none` (print mode: `none` auto-denies anything that would prompt).
- `--model <alias|name>`, `--fallback-model <list>`, `--effort low|medium|high|xhigh|max`.
- `--append-system-prompt <text>`, `--system-prompt <text>`; `--mcp-config <files|json...>`, `--strict-mcp-config`.
- `--allowed-tools`, `--disallowed-tools`, `--tools`; `--add-dir <dirs...>`; `--settings <file|json>`.
- `--max-budget-usd <n>` (print mode), `--no-session-persistence` (print mode), `--json-schema <schema>`.
- `--bare`: skips CLAUDE.md auto-discovery and **only accepts `ANTHROPIC_API_KEY`** (OAuth never read). Do NOT use
  it with subscription auth.

Subcommands of interest: `auth login|logout|status`, `setup-token` ("long-lived authentication token, requires
Claude subscription" → F06), `mcp`, `doctor`, `update` (disabled in the image via `DISABLE_AUTOUPDATER=1`).

## Codex (`codex`)

Usage: `codex [OPTIONS] [PROMPT]` (interactive TUI) or `codex [OPTIONS] <COMMAND>`.

Global options shared with `exec`: `-c key=value` (TOML config override), `--enable/--disable <feature>`,
`-m/--model`, `-p/--profile`, `-s/--sandbox read-only|workspace-write|danger-full-access`,
`-a/--ask-for-approval on-request|never` (top level only), `--dangerously-bypass-approvals-and-sandbox`
("intended solely for environments that are externally sandboxed": our case), `-C/--cd <dir>`, `--add-dir`,
`-i/--image`, `--search`, `--strict-config`.

### `codex exec` (non-interactive, alias `e`): what the adapter (F09) uses
- Prompt as positional argument; `-` or no argument reads stdin (piped stdin + prompt → appended `<stdin>` block).
- `--json`: **events to stdout as JSONL**.
- `-o, --output-last-message <file>`: write the final message to a file.
- `--output-schema <file>`, `--skip-git-repo-check` (needed: bot work dirs aren't always git repos),
  `--ephemeral` (no session files: don't use, we need resume), `--ignore-user-config`, `--ignore-rules`,
  `--color always|never|auto`.
- Resume: **`codex exec resume [SESSION_ID] [PROMPT]`** (or `--last`); accepts `-m`, `-i`,
  `--dangerously-bypass-approvals-and-sandbox`, `--strict-config`. `codex exec fork <id>` also exists.

### Login
- `codex login` (browser), `codex login --device-auth`, `--with-api-key` / `--with-access-token` (stdin).
- `codex login status` → prints `Not logged in` (exit 1) without credentials: a zero-cost check for F06.
- `codex logout`.

### Config (`~/.codex/config.toml`, or `$CODEX_HOME/config.toml`)
Template: `docker/bot/defaults/codex-config.toml`. Verified with `codex mcp list` that it parses and registers:
- `[mcp_servers.playwright]` (stdio: `command`/`args`) and
- `[mcp_servers.agenta]` (streamable HTTP: `url` + `bearer_token_env_var = "AGENTA_MCP_TOKEN"`).
Notes: `--strict-config` is rejected by `codex mcp` and `codex features`. Codex warns (harmlessly) when
`CODEX_HOME` is under `/tmp` ("Refusing to create helper binaries under temporary dir").

## Playwright MCP (`playwright-mcp`)
Flags seen: `--config <path>`, `--browser <browser|channel>`, `--headless` (headed is the default),
`--isolated`, `--user-data-dir <path>`, `--no-sandbox`, `--output-dir <path>`, `--port <port>` (HTTP/SSE
transport, default stdio), `--host <host>`. With `--port`, it serves streamable HTTP at `/mcp` (legacy `/sse`).
Verified: starts with `docker/bot/defaults/playwright-mcp.json`; headed Chromium launches on `DISPLAY=:99`.

## Authentication (F06, observed 2026-10-12)

### Claude Code
- `claude setup-token` (no flags): "Set up a long-lived authentication token (requires Claude subscription)".
  Interactive OAuth: prints a URL, the owner approves in a browser and pastes the code back; the token is printed.
- The CLI reads the token from **`CLAUDE_CODE_OAUTH_TOKEN`**. With it set, `claude auth status` (JSON by default,
  `--text` for prose) prints `"loggedIn": true, "authMethod": "oauth_token"` and exits 0; without any login it prints
  `"loggedIn": false, "authMethod": "none"` and exits 1. **The check is offline**: it passes with
  `docker run --network none` and with a fake `sk-ant-oat01-…` value, so it proves presence/shape, not validity.
- Interactive login (`claude` → `/login`, or `claude auth login`) stores credentials in `~/.claude/.credentials.json`
  (the per-bot fallback; the runner detects that file).
- Token prefix seen in docs/CLI output: `sk-ant-oat01-`. API keys (`sk-ant-api…`) are rejected by our check.

### Codex
- `codex login --device-auth` (device-code flow) or `codex login` (browser callback, unusable headless);
  `--with-api-key` / `--with-access-token` read from stdin.
- Login state = `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`):
  `{ "OPENAI_API_KEY": null, "tokens": { "id_token", "access_token", "refresh_token", "account_id" }, "last_refresh" }`.
  The `id_token` is a JWT whose `https://api.openai.com/auth` claim carries `chatgpt_plan_type` and `chatgpt_account_id`.
- `codex login status`: `Logged in using ChatGPT` (exit 0), `Not logged in` (exit 1), or
  `Error checking login status: invalid ID token format…` (exit 1) for a malformed id_token. **Offline** as well.
- Codex refreshes tokens itself and rewrites auth.json, hence the copy-back after runs.

### Domains (sandbox network policy)
Reachable already: `api.anthropic.com`, `platform.claude.com`. "Approval required" on 2026-10-12:
`claude.ai`, `console.anthropic.com` (Claude OAuth/setup-token), `auth.openai.com` (Codex device login),
`chatgpt.com`, `api.openai.com` (Codex runs). See HUMAN_TODO 12.

### How the runner uses this (apps/runner/src/engines/)
- `EngineAuth.execEnv('claude')` → `{ CLAUDE_CODE_OAUTH_TOKEN }` passed as **exec-time env** only
  (`ContainerManager.exec({ env })`); never in the container spec (`docker inspect` Env), never on disk, redacted in logs.
- The token is read from the shell env, else `.env.local` (re-read on change; no restart needed).
- Codex: `data/secrets/codex/auth.json` (600) → `<home>/.codex/auth.json` (600) before each container start
  (`prepareHome` hook) and before each Codex run (`beforeCodexRun`, F09); `afterCodexRun` copies a newer same-account
  copy back under a lock file. A bot logged in to a *different* account is left alone (per-bot fallback).
- `GET /api/settings/engines[?verify=1]`: state/mode per engine; `verify` runs the offline status commands above
  inside a running bot computer. No prompt is ever sent by these checks.
