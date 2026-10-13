import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  // One worker: specs share the runner's global run cap and the mock engine's usage-limit pause.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Tests must never reach a real engine.
    // E2E gets its own DB so tests never touch the owner's data/agenta.db.
    // Localhost-only even if .env.local exposes the web server for Windows (shell env wins over .env.local).
    env: {
      AGENTA_ENGINE_OVERRIDE: 'mock',
      AGENTA_DB_PATH: 'data/e2e/agenta.db',
      AGENTA_WEB_HOST: '127.0.0.1',
      // Engines always look "not set up" in e2e, whatever the owner has in .env.local / data/secrets.
      CLAUDE_CODE_OAUTH_TOKEN: '',
      AGENTA_SECRETS_DIR: 'data/e2e/secrets',
      // Bots created by e2e get their home folders (and MCP tokens) here, never in the owner's data/bots.
      AGENTA_BOTS_DIR: 'data/e2e/bots',
      AGENTA_SHARED_DIR: 'data/e2e/shared',
    },
  },
});
