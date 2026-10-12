import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { name: 'db', include: ['test/**/*.test.ts'] },
});
