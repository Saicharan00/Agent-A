import { closeDb, createRepos, openDb } from '@agenta/db';
import { loadRootEnv } from '@agenta/shared/env';
import { EventBus } from './bus';
import { loadConfig } from './config';
import { createDockerApi } from './containers/docker';
import { ContainerManager } from './containers/manager';
import { proxyEnv } from './containers/spec';
import { EngineAuth } from './engines/auth';
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
const app = await buildServer(config, { repos, containers, engineAuth });
app.addHook('onClose', async () => {
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

await app.listen({ host: config.host, port: config.port });
if (containers) {
  const docker = await containers.dockerHealth();
  if (docker.ok) app.log.info({ docker: docker.version, image: docker.image }, 'docker ready');
  else app.log.warn({ error: docker.error }, 'docker unreachable: bot computers unavailable');
  containers.startLoops();
}
if (config.engineOverride) app.log.warn({ engine: config.engineOverride }, 'engine override active');
