# Codex `exec --json` fixtures (F09)

Captured from codex-cli 0.162.1 inside `agenta-bot:latest` on 2026-10-13; thread ids replaced.

| File | Source |
|---|---|
| `tools.jsonl` | Real run (`SMOKE=1 pnpm smoke:codex`): "Create hello.txt containing hi, then reply DONE" → a progress message, one `command_execution`, then "DONE" and `turn.completed` usage. |
| `text.jsonl` | Derived from `tools.jsonl`: only the final message and usage. |
| `error.jsonl` | Real run with `--network none` (no usage spent): transient `Reconnecting…` `error` events and an `item.completed` `error` notice. Offline Codex waits for the network forever, so the closing `turn.failed` line is **synthesized** in the documented shape. |
| `limit.jsonl` | **Synthesized** (no limit hit while recording): `error` + `turn.failed` carrying Codex's usage-limit wording. Replace with a real capture when one happens. |
| `resume-missing.stderr.txt` | Real stderr of `codex exec resume <unknown id>` (stdout empty, exit 1). |
