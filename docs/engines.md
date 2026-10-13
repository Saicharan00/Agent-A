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

F16 wiring (observed 2026-10-13, `@playwright/mcp` 0.0.83):
- Both engines run `playwright-mcp --config /opt/agenta/defaults/playwright-mcp.json --user-data-dir /home/bot/.browser-profile`
  (`apps/runner/src/engines/mcp-config.ts`). Claude gets it from `/home/bot/.agenta/mcp.json` (written before every run,
  other servers kept) via `--mcp-config`; Codex from the rendered `config.toml`. The exec env has `DISPLAY=:99`, so the
  browser is headed on the desktop (Chromium argv has no `--headless`; `--user-data-dir=/home/bot/.browser-profile`).
- Over stdio, `tools/call browser_navigate {url}` returns text with `- Page URL: …` and `- Page Title: …`. Claude reports
  the call as `mcp__playwright__browser_navigate` with input `{url}`.
- The config file must be readable by `bot`: an unreadable one fails with `EACCES … playwright-mcp.json` and the server
  never starts (the Dockerfile now `chmod -R a+rX`es `/opt/agenta/defaults`).
- Chromium trusts only `~/.pki/nssdb`, not `/etc/ssl`: without the sandbox proxy CA there, HTTPS pages fail with
  `net::ERR_CERT_AUTHORITY_INVALID`. The entrypoint adds the image's extra CAs with `certutil` (`libnss3-tools`).
- Sites a bot browses go through the Docker Sandbox network policy like everything else: an unapproved host gets a 403
  "Approval required for <host>" page.

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

## Claude Code adapter (F08, observed 2026-10-13 with 2.1.296)

Command (`apps/runner/src/engines/claude.ts` → `buildClaudeArgs`), run with `docker exec` as `bot`, cwd `/home/bot/work`,
exec env `CLAUDE_CODE_OAUTH_TOKEN` + `DISPLAY=:99`:
```
claude -p --output-format stream-json --verbose --include-partial-messages --dangerously-skip-permissions
       (--session-id <new uuid> | --resume <id>) [--model <m>] [--append-system-prompt-file <file>] [--mcp-config <file>]
       < /home/bot/.agenta/runs/<uuid>/prompt.md
```
- `--verbose` is **still required**: without it → `Error: When using --print, --output-format=stream-json requires --verbose`.
- The prompt goes on **stdin** from a per-run file and the system text via `--append-system-prompt-file`
  (no argv length/escaping limits; the prompt never shows in `ps`). Both files are deleted after the run.
- `--session-id <uuid>` for new sessions, so `run.started` carries the id before the CLI starts. `--resume <id>` keeps the
  same session id in the output.
- `--mcp-config` is only passed when the file exists (F17 renders it).
- Process control: wrapped as `setsid -w sh -c 'echo $$ > /tmp/agenta-proc-<uuid>.pid; exec "$@" < prompt'`, so the CLI
  leads its own process group. Cancel = `kill -s INT -- -<pgid>`, then `KILL` after 5 s, and always a final group
  `KILL` (background jobs of non-interactive shells ignore SIGINT and would survive). `setsid -w` reports a
  signal death as the signal number (9), not 137.
- Offline (`--network none`, fake token) startup takes ~15 s before `system/init` (network timeouts); online it is ~1–2 s.

Stream-json messages seen (one JSON object per line):
| Message | Mapped to |
|---|---|
| `system` `init` (`session_id`, `tools`, `mcp_servers`, `model`, `permissionMode: bypassPermissions`, `claude_code_version`) | session id |
| `system` `status` / `api_retry` (`attempt`, `max_retries`, `retry_delay_ms`, `error`) | nothing (debug) |
| `stream_event` → `content_block_delta` / `text_delta` (with `--include-partial-messages`) | `text.delta` (top level only) |
| `assistant` `message.content[]`: `text` / `thinking` / `tool_use {id,name,input}` (one message per block) | `text.final` / `thinking` / `tool.call` |
| `assistant` with `error: "server_error"` + `is_api_error_message: true` (synthetic, `model: "<synthetic>"`) | `error` (or `limit.hit`) |
| `user` `message.content[]` `tool_result {tool_use_id, content, is_error}` + top-level `tool_use_result` (Write: `{type:"create"\|"update", filePath}`) | `tool.result` (+ `file.changed` for Write/Edit/MultiEdit/NotebookEdit) |
| `rate_limit_event` `rate_limit_info {status: "allowed", resetsAt: <epoch s>, rateLimitType: "five_hour", unifiedWindows…}` | `limit.hit` when `status: "rejected"` |
| `result` (`subtype`, `is_error`, `result`, `errors[]`, `total_cost_usd`, `usage{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`) | `usage` (+ `error`) |

- An API failure ends with `result` `subtype: "success"` **but** `is_error: true` and `result: "API Error: …"`: trust `is_error`.
- Unknown resume id: a lone `result` `error_during_execution`, `errors: ["No conversation found with session ID: <id>"]`,
  the same text on stderr, exit 1 → the adapter retries once with a new session and emits a `system` event.
- SIGINT mid-run: the CLI writes a final `result` (`error_during_execution`) and exits.
- **Usage limit: not observed yet.** Detected from `rate_limit_event.status === "rejected"` (its `resetsAt`), an
  assistant `error: "rate_limit"`, or limit wording ("usage limit reached", "hit your limit · resets 3pm (Zone)",
  "Claude AI usage limit reached|<epoch>"); reset parsing in `limits.ts`. Replace `test/fixtures/claude/limit.jsonl`
  with a real capture when one happens.

## Codex adapter (F09, observed 2026-10-13 with codex-cli 0.162.1)

Command (`apps/runner/src/engines/codex.ts` → `buildCodexArgs`), same launcher as F08 (`setsid` group, prompt on stdin):
```
codex exec            --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-m <m>] [-c developer_instructions="<system text>"] -
codex exec resume <id> --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-m <m>] [-c developer_instructions="…"] -
```
- `-` = read the prompt from stdin (without it and with an open stdin Codex prints "Reading additional input from stdin…").
- `exec resume` has no `-C/--cd`; the cwd comes from the exec workdir (`/home/bot/work`) for both forms.
- **No system-prompt flag**: `-c developer_instructions="…"` (TOML basic string) works and appears as the first
  developer message (verified with `codex debug prompt-input`, offline).
- **AGENTS.md discovery**: Codex reads `AGENTS.md` from the git root down to the cwd, so `/home/bot/AGENTS.md` is
  **not** read when the cwd is `/home/bot/work`. It always reads `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md`), so the
  adapter mirrors the rendered file there before each run.
- `~/.codex/config.toml` is rendered before each run: `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`,
  Playwright MCP, plus the servers of the bot's Claude-style MCP config (F17). Stdio → `command`/`args`/`env`;
  HTTP → `url` + `http_headers` (checked with `codex mcp get --json`). Unknown keys only fail with `--strict-config`.
- `codex debug prompt-input [-c …] [PROMPT]` renders the model-visible input as JSON with no network: the tool for
  checking instructions.

JSONL events seen:
| Event | Mapped to |
|---|---|
| `thread.started {thread_id}` | session id (resume with `exec resume <thread_id>`) |
| `turn.started` | nothing |
| `item.started` / `item.completed` `command_execution {command, aggregated_output, exit_code, status}` | `tool.call` `shell` / `tool.result` (error if exit ≠ 0 or failed) |
| `item.completed` `agent_message {text}` (no streaming deltas; also mid-turn progress messages) | `text.final` |
| `item.*` `reasoning {text}` · `file_change {changes:[{path, kind: add\|update\|delete}]}` · `mcp_tool_call {server, tool, arguments, result, error}` · `web_search {query}` (documented shapes, not in the smoke run) | `thinking` · `apply_patch` call/result + `file.changed` · `mcp__<server>__<tool>` · `web_search` |
| `item.completed` `error {message}` (e.g. "Falling back from WebSockets to HTTPS transport…") | nothing (notice) |
| `error {message}` "Reconnecting... 2/5 (…)" / "Reconnecting... waiting for network" | nothing (transient) |
| `turn.completed {usage: {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}}` | `usage` (input already includes cached; output + reasoning) |
| `turn.failed {error: {message}}` | `error` or `limit.hit` |

- Files written by shell commands (e.g. `printf hi > hello.txt`, what the smoke run did) produce no `file.changed`;
  only `file_change` items do.
- **Offline / no network: Codex retries forever** ("Reconnecting... waiting for network"); the run orchestrator must
  apply a timeout (F10).
- Unknown resume id: nothing on stdout, stderr `Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)`,
  exit 1 → retry once as a new thread + `system` event.
- Without auth.json Codex still starts and fails on the API (no early "not logged in").
- **Usage limit: not observed yet.** Detected from wording ("You've hit your usage limit… try again at 3:05 PM" /
  "… at Oct 14th, 2026 9:05 AM" / "in N minutes") in `error`/`turn.failed`/stderr; times are the container's zone (UTC).

## Platform MCP server (F17)
- Both engines reach it as `http://host.docker.internal:3002/mcp` (the runner listens on the `agenta-net` gateway).
- Claude: `/home/bot/.agenta/mcp.json` → `"agenta": {"type": "http", "url": …, "headers": {"Authorization": "Bearer <token>"}}`
  (written before every real run, mode 600). Codex: the same entry translated to `[mcp_servers.agenta]` `url` +
  `http_headers` (the runtime config uses the header, not the template's `bearer_token_env_var`).
- Verified 2026-10-13 from inside a bot container with curl: no/wrong token → 401; `tools/call whoami` with the bot's
  token → its identity. Tools appear to engines as `mcp__agenta__<tool>`.
