import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Real-engine smoke tests: spend subscription usage. Only with SMOKE=1; never part of `pnpm test`.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { name: 'smoke', include: ['*.smoke.test.ts'], testTimeout: 180_000 },
});
