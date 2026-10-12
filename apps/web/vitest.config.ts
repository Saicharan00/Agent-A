import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { name: 'web', include: ['test/**/*.test.ts'] },
});
