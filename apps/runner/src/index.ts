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
import { ContainerLauncher } from './engines/process';
import { FilesService } from './files/service';
import { EngineRegistry } from './engines/registry';
import { DockerMonitor } from './live/docker-monitor';
import { LiveHub } from './live/hub';
import { computerPreparer } from './runs/prepare';
import { RunService } from './runs/service';
import { TerminalService } from './terminal/service';
import { DesktopService } from './desktop/service';
import { ThreadService } from './threads/service';
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
      prepareHome: (botId, home) => engineAuth.prepareHome(botId, home),
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
const engineAdapters: ConstructorParameters<typeof EngineRegistry>[0] = [new MockEngine()];
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
const runs = new RunService({
  repos,
  bus,
  engines: new EngineRegistry(engineAdapters, config.engineOverride),
  log: rootLog.child({ module: 'runs' }),
  prepare: computerPreparer({
    containers,
    botsDir: config.botsDir,
    ensureToken: (botId) => void ensureMcpToken(repos, config.botsDir, botId),
  }),
});
const bots = new BotService({
  repos,
  bus,
  log: rootLog.child({ module: 'bots' }),
  botsDir: config.botsDir,
  containers,
  runs,
});
const threads = new ThreadService({
  repos,
  bus,
  log: rootLog.child({ module: 'threads' }),
  botsDir: config.botsDir,
  bots,
  runs,
});
const files = new FilesService({
  repos,
  bus,
  log: rootLog.child({ module: 'files' }),
  botsDir: config.botsDir,
  sharedDir: config.sharedDir,
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
});
app.addHook('onClose', async () => {
  dockerMonitor?.stop();
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
await app.listen({ host: config.host, port: config.port });
if (containers) {
  const docker = await containers.dockerHealth();
  if (docker.ok) app.log.info({ docker: docker.version, image: docker.image }, 'docker ready');
  else app.log.warn({ error: docker.error }, 'docker unreachable: bot computers unavailable');
  containers.startLoops();
  dockerMonitor?.start();
}
if (config.engineOverride) app.log.warn({ engine: config.engineOverride }, 'engine override active');
