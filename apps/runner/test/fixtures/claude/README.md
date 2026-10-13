# Claude Code stream-json fixtures (F08)

Captured from Claude Code 2.1.296 inside `agenta-bot:latest` on 2026-10-13, then sanitized (session id, message ids,
uuids and timestamps replaced; long capability lists in `system/init` trimmed to 3 items).

| File | Source |
|---|---|
| `tools.jsonl` | Real run (`SMOKE=1 pnpm smoke:claude`): "Create hello.txt containing hi, then reply DONE" → Write tool, then text. |
| `text.jsonl` | Derived from `tools.jsonl`: `system/init` + the final text-only turn + `result`. |
| `error.jsonl` | Real run with `--network none` (no usage spent): `api_retry` events (trimmed to 2), a synthetic `assistant` message with `error: "server_error"`, then `result` with `is_error: true` and `subtype: "success"`. |
| `resume-missing.jsonl` | Real: `--resume <unknown id>` → a single `result` (`error_during_execution`, `errors: ["No conversation found with session ID: …"]`), exit 1. |
| `limit.jsonl` | **Synthesized from observed shapes** (no limit was hit while recording): the real `rate_limit_event` with `status` changed from `allowed` to `rejected`, the real API-error assistant message with `error: "rate_limit"` and limit text, and an error `result`. Replace with a real capture when a limit is hit. |
