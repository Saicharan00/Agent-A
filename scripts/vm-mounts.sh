#!/bin/sh
# Bind-mounts dependency/build dirs from the sandbox VM's Linux disk into the project.
# Why: the project folder is a Windows virtiofs mount that forbids symlinks and fails pnpm's
# rename-based installs (see docs/DECISIONS.md). Idempotent and silent; safe to run often.
# data/bots and data/shared are bot homes / team share: bind-mounted into bot containers, and they
# need symlinks too (npm, Python venvs, git). They live on the VM disk, NOT on the Windows folder.
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${AGENTA_VM_CACHE:-$HOME/.cache/agenta-vm}"
for rel in node_modules apps/web/node_modules apps/web/.next apps/runner/node_modules \
           packages/shared/node_modules packages/db/node_modules data/bots data/shared; do
  target="$REPO/$rel"
  case "$rel" in data/*) mkdir -p "$REPO/data" 2>/dev/null ;; esac
  [ -d "$(dirname "$target")" ] || continue
  if mountpoint -q "$target" 2>/dev/null; then continue; fi
  src="$STORE/$(echo "$rel" | tr / _)"
  mkdir -p "$src" "$target" 2>/dev/null
  sudo -n mount --bind "$src" "$target" 2>/dev/null || echo "vm-mounts: could not mount $rel" >&2
done
