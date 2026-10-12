import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: { name: 'runner', include: ['test/**/*.test.ts'] },
});
