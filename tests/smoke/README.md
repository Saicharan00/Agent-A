# Real-engine smoke tests

Specs here call real Claude Code / Codex and spend subscription usage.
They only run when `SMOKE=1` is set and are never part of `pnpm test` or `pnpm e2e`.

- `SMOKE=1 pnpm smoke:auth` (F06): one "reply OK" prompt per configured engine, in a throwaway bot container.
- `SMOKE=1 pnpm smoke:claude` (F08): one real Claude Code turn through the adapter ("Create hello.txt containing hi,
  then reply DONE") in a throwaway bot computer; saves the raw transcript to `data/smoke/claude-F08.jsonl`.
