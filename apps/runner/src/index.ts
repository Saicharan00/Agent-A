import { dirname, join } from 'node:path';
import { closeDb, createRepos, openDb } from '@agenta/db';
import { DEFAULT_PORTS } from '@agenta/shared';
import { findRepoRoot, loadRootEnv } from '@agenta/shared/env';
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
import { PlatformMcpServer, inProcessPlatform } from './mcp/server';
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
import { ConnectorService } from './connectors/service';
import { GatewayService } from './gateway/service';
import { appendHumanTodo } from './gateway/human-todo';
import { GatewayOAuth } from './gateway/oauth';
import { LOG_REDACT, buildServer } from './server';
import { realProbes } from './system/doctor';
import { ImageBuilder } from './system/image-build';
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
const secrets = envFileSource({ shellEnv, envFile: config.envFile });
const connectors = new ConnectorService({ repos, secrets });
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
        if (bot)
          renderHome(
            home,
            bot,
            skillsDir,
            memories.forRender(botId),
            connectors.forBot(botId),
            gateway.instructionTools(botId),
          );
      },
    })
  : undefined;
const engineAuth: EngineAuth = new EngineAuth({
  secrets,
  secretsDir: config.secretsDir,
  botsDir: config.botsDir,
  repos,
  exec: containers && ((botId, opts) => containers.exec(botId, opts)),
  log: rootLog.child({ module: 'engine-auth' }),
});
// The mock engine calls the same Platform MCP tools in-process (`platformTools` and `gateway` are created below,
// before any run).
const engineAdapters: ConstructorParameters<typeof EngineRegistry>[0] = [
  new MockEngine({
    platform: {
      call: (name, input, botId) => inProcessPlatform(repos, platformTools, gateway).call(name, input, botId),
    },
  }),
];
if (containers) {
  const launcher = new ContainerLauncher((id, o) => containers.exec(id, o), config.botsDir);
  engineAdapters.push(
    new ClaudeEngine({
      launcher,
      env: (botId) => ({ ...engineAuth.execEnv('claude'), ...connectors.execEnv(botId) }),
      log: rootLog.child({ module: 'engine-claude' }),
    }),
    new CodexEngine({
      launcher,
      env: (botId) => connectors.execEnv(botId),
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
    connectors: (botId) => connectors.forBot(botId),
    tools: (botId) => gateway.instructionTools(botId),
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
const gateway = new GatewayService({
  repos,
  secrets,
  approvals,
  log: rootLog.child({ module: 'gateway' }),
  sandboxName: config.sandboxName,
  humanTodo: (item) => appendHumanTodo(config.humanTodoFile, item),
  // The owner's browser comes back through the web app's /api proxy (F01), so the runner stays on 127.0.0.1.
  oauth: new GatewayOAuth(join(config.secretsDir, 'mcp-oauth'), `${config.webOrigin}/api/mcp-oauth/callback`),
});
const platformMcp = new PlatformMcpServer({
  repos,
  tools: platformTools,
  gateway,
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
  containers &&
  new TerminalService({
    containers,
    log: rootLog.child({ module: 'terminal' }),
    env: (botId) => connectors.execEnv(botId),
  });
const desktops =
  containers && new DesktopService({ containers, bus, log: rootLog.child({ module: 'desktop' }) });
const dockerMonitor = containers && new DockerMonitor({ bus, health: () => containers.dockerHealth() });
const repoRoot = findRepoRoot();
const app = await buildServer(config, {
  system: {
    images: new ImageBuilder({ cwd: repoRoot, log: rootLog.child({ module: 'image-build' }) }),
    paths: {
      data: join(repoRoot, 'data'),
      db: config.dbPath,
      bots: config.botsDir,
      shared: config.sharedDir,
      secrets: config.secretsDir,
      backups: join(repoRoot, 'data', 'backups'),
    },
    probes: () =>
      realProbes({
        repoRoot,
        dataDir: dirname(config.dbPath),
        ports: {
          web: Number(process.env.AGENTA_WEB_PORT) || DEFAULT_PORTS.web,
          runner: config.port,
          mcp: config.mcpPort,
        },
        selfPorts: [config.port, config.mcpPort],
        integrity: () => db.$client.pragma('integrity_check', { simple: true }) as string,
        engines: () => engineAuth.statuses(),
      }),
  },
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
  connectors,
  gateway,
});
app.addHook('onClose', async () => {
  dockerMonitor?.stop();
  schedules.stop();
  await platformMcp.close();
  // Stops the stdio MCP servers the gateway started.
  await gateway.close();
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
