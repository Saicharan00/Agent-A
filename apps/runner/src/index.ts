import { closeDb, createRepos, openDb } from '@agenta/db';
import { loadRootEnv } from '@agenta/shared/env';
import { EventBus } from './bus';
import { loadConfig } from './config';
import { createDockerApi } from './containers/docker';
import { ContainerManager } from './containers/manager';
import { proxyEnv } from './containers/spec';
import { buildServer } from './server';
import pino from 'pino';

loadRootEnv();
const config = loadConfig();
// Opening the DB applies pending migrations (idempotent), so a fresh checkout just works.
const db = openDb(config.dbPath);
const repos = createRepos(db);
const bus = new EventBus();
const containers = config.dockerEnabled
  ? new ContainerManager({
      docker: createDockerApi(),
      repos,
      bus,
      log: pino({ level: config.logLevel }).child({ module: 'containers' }),
      botsDir: config.botsDir,
      sharedDir: config.sharedDir,
      containerEnv: proxyEnv(process.env),
    })
  : undefined;
const app = await buildServer(config, { repos, containers });
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
