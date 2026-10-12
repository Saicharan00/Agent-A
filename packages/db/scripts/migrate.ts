// pnpm db:migrate — applies pending migrations to AGENTA_DB_PATH (default data/agenta.db).
import { findRepoRoot, loadRootEnv } from '@agenta/shared/env';
import { closeDb, openDb, resolveDbPath } from '../src/index';

loadRootEnv();
const file = resolveDbPath(findRepoRoot());
const db = openDb(file);
closeDb(db);
console.log(`migrated ${file}`);
