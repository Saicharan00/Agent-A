Templates the container manager (F05/F06) renders into each bot's home. `{{NAME}}` placeholders are
replaced per bot; nothing here contains secrets.

- `claude-settings.json` → `/home/bot/.claude/settings.json`
- `codex-config.toml` → `/home/bot/.codex/config.toml`
- `playwright-mcp.json` → Playwright MCP config (headed Chromium on the container's `:99` desktop)
