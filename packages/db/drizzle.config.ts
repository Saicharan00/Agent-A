import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` diffs src/schema.ts against ./drizzle and writes a new SQL migration.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
});
