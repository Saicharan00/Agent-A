# agenta-bot: the computer every bot runs in (one container per bot, see PLAN.md F04/F05).
# Build with `pnpm image:build`, which passes the proxy build args and the git-sha tag.
FROM node:22-bookworm

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG PLAYWRIGHT_MCP_VERSION=latest

LABEL agenta="1" \
      org.opencontainers.image.title="agenta-bot" \
      org.opencontainers.image.description="Agent A bot computer: engines, dev tools, headed browser, noVNC desktop"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC

# Trust extra CAs (the Docker Sandbox proxy intercepts TLS for some hosts, e.g. api.anthropic.com).
# scripts/image-build.ts copies them into certs/; the directory may hold only its README.
COPY certs/ /usr/local/share/ca-certificates/agenta/
RUN find /usr/local/share/ca-certificates/agenta -type f ! -name '*.crt' -delete \
 && update-ca-certificates
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Dev tools + desktop stack. GitHub CLI comes from its official apt repo.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git wget jq ripgrep fd-find unzip zip build-essential \
      python3 python3-pip python3-venv sqlite3 less vim-tiny procps tini gh \
      xvfb fluxbox x11vnc novnc websockify \
      fonts-liberation fonts-noto-color-emoji \
 && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Engines + Playwright MCP. The `playwright` CLI is pinned to the exact version @playwright/mcp
# depends on, so the browser it installs is the revision the MCP server expects.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    DISABLE_AUTOUPDATER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g --no-fund --no-audit \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && PW_VERSION="$(node -p "require('/usr/local/lib/node_modules/@playwright/mcp/package.json').dependencies.playwright")" \
 && npm install -g --no-fund --no-audit "playwright@${PW_VERSION}" \
 && playwright install --with-deps chromium \
 && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

# The base image's `node` user already has uid/gid 1000; rename it to `bot`.
RUN groupmod -n bot node \
 && usermod -l bot -d /home/bot -m -s /bin/bash -c "Agent A bot" node \
 && mkdir -p /home/bot/work /home/bot/.claude /home/bot/.codex /shared /tmp/.X11-unix \
 && chmod 1777 /tmp/.X11-unix \
 && chown -R bot:bot /home/bot /shared

# certutil: Chromium trusts only its own NSS db, so the entrypoint adds the extra CAs above to the bot's.
# (A separate layer so the big package layer above stays cached.)
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools && rm -rf /var/lib/apt/lists/*

# World-readable whatever mode the files have on the host (the bot user reads them at run time).
COPY defaults/ /opt/agenta/defaults/
RUN chmod -R a+rX /opt/agenta/defaults
COPY --chmod=755 entrypoint.sh /usr/local/bin/agenta-entrypoint

ENV DISPLAY=:99 \
    AGENTA_SCREEN=1440x900x24 \
    NOVNC_PORT=6080

USER bot
WORKDIR /home/bot/work
EXPOSE 6080

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${NOVNC_PORT}/vnc.html" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/agenta-entrypoint"]
CMD ["sleep", "infinity"]
