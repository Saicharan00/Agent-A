import { join } from 'node:path';
import { closeDb, createRepos, openDb } from '@agenta/db';
import { loadRootEnv } from '@agenta/shared/env';
import { BotService } from './bots/service';
import { ensureMcpToken } from './bots/mcp-token';
import { EventBus } from './bus';
import { loadConfig } from './config';
import { createDockerApi } from './containers/docker';
import { ContainerManager } from './containers/manager';
import { proxyEnv } from './containers/spec';
import { EngineAuth } from './engines/auth';
import { ClaudeEngine } from './engines/claude';
import { CodexEngine } from './engines/codex';
import { MockEngine } from './engines/mock';
import { PlatformMcpServer } from './mcp/server';
import { PlatformTools } from './mcp/tools';
import { ContainerLauncher } from './engines/process';
import { FilesService } from './files/service';
import { GoalService } from './goals/service';
import { LearnService } from './learn/service';
import { MemoryService } from './memories/service';
import { EngineRegistry } from './engines/registry';
import { DockerMonitor } from './live/docker-monitor';
import { LiveHub } from './live/hub';
import { computerPreparer, renderHome } from './runs/prepare';
import { RunService } from './runs/service';
import { TerminalService } from './terminal/service';
import { DesktopService } from './desktop/service';
import { TaskService } from './tasks/service';
import { ThreadService } from './threads/service';
import { GuardService } from './guard/service';
import { ApprovalService } from './approvals/service';
import { ScheduleService } from './schedules/service';
import { NotificationService } from './notifications/service';
import { envFileSource } from './engines/secrets';
import { LOG_REDACT, buildServer } from './server';
import pino from 'pino';

// Snapshot before .env.local is merged in: variables set by the shell win over the file (see envFileSource).
const shellEnv = { ...process.env };
loadRootEnv();
const config = loadConfig();
const rootLog = pino({ level: config.logLevel, redact: LOG_REDACT });
// Opening the DB applies pending migrations (idempotent), so a fresh checkout just works.
const db = openDb(config.dbPath);
const repos = createRepos(db);
const bus = new EventBus();
const guard = new GuardService({ repos, log: rootLog.child({ module: 'guard' }) });
const memories = new MemoryService({
  repos,
  bus,
  log: rootLog.child({ module: 'memories' }),
  sharedDir: config.sharedDir,
});
const skillsDir = join(config.teamDir, 'skills');
const containers = config.dockerEnabled
  ? new ContainerManager({
      docker: createDockerApi(),
      repos,
      bus,
      log: rootLog.child({ module: 'containers' }),
      botsDir: config.botsDir,
      sharedDir: config.sharedDir,
      // Proxy settings only: engine credentials are injected per exec (EngineAuth.execEnv), never here.
      containerEnv: proxyEnv(process.env),
      prepareHome: async (botId, home) => {
        await engineAuth.prepareHome(botId, home);
        // Instruction files and skills are in the home from the first start, not only after the first run.
        const bot = repos.bots.get(botId);
        if (bot) renderHome(home, bot, skillsDir, memories.forRender(botId));
      },
    })
  : undefined;
const engineAuth: EngineAuth = new EngineAuth({
  secrets: envFileSource({ shellEnv, envFile: config.envFile }),
  secretsDir: config.secretsDir,
  botsDir: config.botsDir,
  repos,
  exec: containers && ((botId, opts) => containers.exec(botId, opts)),
  log: rootLog.child({ module: 'engine-auth' }),
});
// The mock engine calls the same Platform MCP tools in-process (`platformTools` is created below, before any run).
const engineAdapters: ConstructorParameters<typeof EngineRegistry>[0] = [
  new MockEngine({
    platform: {
      call: async (name, input, botId) => {
        const bot = repos.bots.get(botId);
        if (!bot) throw new Error(`Bot ${botId} not found`);
        return JSON.stringify(await platformTools.call(bot, name, input), null, 2);
      },
    },
  }),
];
if (containers) {
  const launcher = new ContainerLauncher((id, o) => containers.exec(id, o), config.botsDir);
  engineAdapters.push(
    new ClaudeEngine({
      launcher,
      env: () => engineAuth.execEnv('claude'),
      log: rootLog.child({ module: 'engine-claude' }),
    }),
    new CodexEngine({
      launcher,
      env: () => ({}),
      log: rootLog.child({ module: 'engine-codex' }),
      beforeRun: (id) => engineAuth.beforeCodexRun(id),
      afterRun: (id) => engineAuth.afterCodexRun(id),
    }),
  );
}
const engines = new EngineRegistry(engineAdapters, config.engineOverride);
const runs = new RunService({
  repos,
  bus,
  engines,
  log: rootLog.child({ module: 'runs' }),
  prepare: computerPreparer({
    containers,
    botsDir: config.botsDir,
    ensureToken: (botId) => void ensureMcpToken(repos, config.botsDir, botId),
    platformMcpUrl: `http://host.docker.internal:${config.mcpPort}/mcp`,
    skillsDir,
    memories: (botId) => memories.forRender(botId),
  }),
});
const bots = new BotService({
  repos,
  bus,
  log: rootLog.child({ module: 'bots' }),
  botsDir: config.botsDir,
  containers,
  runs,
  teamDir: config.teamDir,
});
const threads = new ThreadService({
  repos,
  bus,
  log: rootLog.child({ module: 'threads' }),
  botsDir: config.botsDir,
  bots,
  runs,
  guard,
});
const tasks = new TaskService({ repos, bus, runs, threads, log: rootLog.child({ module: 'tasks' }) });
const goals = new GoalService({
  repos,
  bus,
  runs,
  threads,
  tasks,
  sharedDir: config.sharedDir,
  log: rootLog.child({ module: 'goals' }),
});
runs.onReply = (run, reply) => {
  threads.routeBotMessage(reply, run);
  goals.onReply(run);
};
const learn = new LearnService({
  repos,
  bus,
  log: rootLog.child({ module: 'learn' }),
  sharedDir: config.sharedDir,
  threads,
});
const schedules = new ScheduleService({
  repos,
  threads,
  effectiveEngine: (bot) => engines.effectiveEngine(bot),
  bus,
  log: rootLog.child({ module: 'schedules' }),
});
const notifications = new NotificationService({ repos, bus });
const approvals = new ApprovalService({ repos, bus, log: rootLog.child({ module: 'approvals' }) });
const platformTools = new PlatformTools({
  repos,
  approvals,
  threads,
  bus,
  tasks,
  goals,
  memories,
  learn,
  log: rootLog.child({ module: 'platform-tools' }),
});
const platformMcp = new PlatformMcpServer({
  repos,
  tools: platformTools,
  log: rootLog.child({ module: 'platform-mcp' }),
});
const files = new FilesService({
  repos,
  bus,
  log: rootLog.child({ module: 'files' }),
  botsDir: config.botsDir,
  sharedDir: config.sharedDir,
  guard,
});
const live = new LiveHub({ bus, runs: repos.runs, log: rootLog.child({ module: 'live' }) });
const terminals =
  containers && new TerminalService({ containers, log: rootLog.child({ module: 'terminal' }) });
const desktops =
  containers && new DesktopService({ containers, bus, log: rootLog.child({ module: 'desktop' }) });
const dockerMonitor = containers && new DockerMonitor({ bus, health: () => containers.dockerHealth() });
const app = await buildServer(config, {
  repos,
  containers,
  engineAuth,
  runs,
  live,
  bots,
  threads,
  terminals,
  desktops,
  files,
  tasks,
  goals,
  memories,
  learn,
  guard,
  approvals,
  schedules,
  notifications,
});
app.addHook('onClose', async () => {
  dockerMonitor?.stop();
  schedules.stop();
  await platformMcp.close();
  // Stops running engines and records them as failed ("runner stopped") before the DB closes.
  await runs.shutdown();
  // Bot containers keep running across runner restarts; the reconcile loop adopts them on start.
  containers?.stopLoops();
  closeDb(db);
});
app.log.info({ dbPath: config.dbPath }, 'database ready');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Recover runs a previous process left `running`, then start scheduling queued work.
runs.start();
// Fires due schedules (missed ones are skipped or caught up, per schedule) and then every 30 s.
schedules.start();
await app.listen({ host: config.host, port: config.port });
await platformMcp.listen(config.host, config.mcpPort);
if (containers) {
  const docker = await containers.dockerHealth();
  if (docker.ok) {
    app.log.info({ docker: docker.version, image: docker.image }, 'docker ready');
    // Bots reach the Platform MCP server as host.docker.internal = the bot network's gateway (DECISIONS F05).
    try {
      await platformMcp.listen(await containers.networkGateway(), config.mcpPort);
    } catch (err) {
      app.log.error(
        { err },
        'platform MCP unreachable from bots: could not listen on the bot network gateway',
      );
    }
  } else app.log.warn({ error: docker.error }, 'docker unreachable: bot computers unavailable');
  containers.startLoops();
  dockerMonitor?.start();
}
if (config.engineOverride) app.log.warn({ engine: config.engineOverride }, 'engine override active');
