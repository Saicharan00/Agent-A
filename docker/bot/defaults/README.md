Templates the container manager (F05/F06) renders into each bot's home. `{{NAME}}` placeholders are
replaced per bot; nothing here contains secrets.

- `claude-settings.json` → `/home/bot/.claude/settings.json`
- `codex-config.toml`: image default / reference only. Since F09 the runner renders `/home/bot/.codex/config.toml`
  itself before every Codex run (`apps/runner/src/engines/codex.ts`, same settings + the bot's MCP servers).
- `playwright-mcp.json` → Playwright MCP config (headed Chromium on the container's `:99` desktop)
