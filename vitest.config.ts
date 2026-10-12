import { defineConfig } from 'vitest/config';

// Root runner: each workspace package owns its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'scripts'],
  },
});
