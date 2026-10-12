import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Real-Docker integration tests (`pnpm test:docker`). Not part of `pnpm test`.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { tsconfigPaths: true },
  test: {
    name: 'runner-docker',
    include: ['test-docker/**/*.docker.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
