// pnpm db:seed — migrates, then creates the Agent A team and its Lead Room from templates/team (idempotent).
import { join } from 'node:path';
import { findRepoRoot, loadRootEnv } from '@agenta/shared/env';
import {
  applyTeamTemplate,
  closeDb,
  createRepos,
  loadTeamTemplate,
  openDb,
  resolveDbPath,
} from '../src/index';

loadRootEnv();
const root = findRepoRoot();
const file = resolveDbPath(root);
const db = openDb(file);
const { created, leadRoom, leadRoomCreated } = applyTeamTemplate(
  createRepos(db),
  loadTeamTemplate(join(root, 'templates/team')),
  { restore: false },
);
closeDb(db);
console.log(
  created.length || leadRoomCreated
    ? `seeded ${file}: ${created.map((b) => b.name).join(', ') || 'no new bots'}${leadRoomCreated ? `; ${leadRoom.title} (${leadRoom.id})` : ''}`
    : `already seeded ${file}`,
);
