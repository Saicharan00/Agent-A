import type { Db } from '../client';
import { makeBotsRepo } from './bots';
import { makeGoalsRepo } from './goals';
import { makeDecisionsRepo, makeLessonsRepo, makeMemoriesRepo } from './knowledge';
import { makeMcpServersRepo } from './mcp';
import { makeMessagesRepo } from './messages';
import { makeApprovalsRepo, makeEngineStateRepo, makeNotificationsRepo, makeSchedulesRepo } from './ops';
import { makeConnectorsRepo, makeGuardTermsRepo, makeSettingsRepo } from './platform';
import { makeRunsRepo } from './runs';
import { makeSessionsRepo } from './sessions';
import { makeTasksRepo } from './tasks';
import { makeThreadsRepo } from './threads';

/** Every repository bound to one DB handle. The only place SQL lives (CLAUDE.md). */
export function createRepos(db: Db) {
  return {
    bots: makeBotsRepo(db),
    threads: makeThreadsRepo(db),
    messages: makeMessagesRepo(db),
    sessions: makeSessionsRepo(db),
    runs: makeRunsRepo(db),
    tasks: makeTasksRepo(db),
    goals: makeGoalsRepo(db),
    memories: makeMemoriesRepo(db),
    decisions: makeDecisionsRepo(db),
    lessons: makeLessonsRepo(db),
    approvals: makeApprovalsRepo(db),
    schedules: makeSchedulesRepo(db),
    notifications: makeNotificationsRepo(db),
    engineState: makeEngineStateRepo(db),
    connectors: makeConnectorsRepo(db),
    guardTerms: makeGuardTermsRepo(db),
    settings: makeSettingsRepo(db),
    mcpServers: makeMcpServersRepo(db),
  };
}
export type Repos = ReturnType<typeof createRepos>;

export * from './bots';
export * from './goals';
export * from './knowledge';
export * from './mcp';
export * from './messages';
export * from './ops';
export * from './platform';
export * from './runs';
export * from './sessions';
export * from './tasks';
export * from './threads';
