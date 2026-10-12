// pnpm db:seed — migrates, then creates the Echo Bot and its DM thread (idempotent).
import { findRepoRoot, loadRootEnv } from '@agenta/shared/env';
import { closeDb, createRepos, openDb, resolveDbPath, seedDb } from '../src/index';

loadRootEnv();
const file = resolveDbPath(findRepoRoot());
const db = openDb(file);
const { bot, thread, created } = seedDb(createRepos(db));
closeDb(db);
console.log(`${created ? 'seeded' : 'already seeded'} ${file}: ${bot.name} (${bot.id}), DM ${thread.id}`);
