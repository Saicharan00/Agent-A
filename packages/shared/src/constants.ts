export const APP_NAME = 'Agent A';

export const DEFAULT_PORTS = {
  web: 3000,
  runner: 3001,
  mcp: 3002,
} as const;

/** Every server binds here unless explicitly overridden (see docs/DECISIONS.md). */
export const DEFAULT_BIND_HOST = '127.0.0.1';

export const DEFAULT_RUNNER_URL = `http://${DEFAULT_BIND_HOST}:${DEFAULT_PORTS.runner}`;
export const DEFAULT_WEB_ORIGIN = `http://localhost:${DEFAULT_PORTS.web}`;
