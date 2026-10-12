import { loadRootEnv } from '@agenta/shared/env';
import { loadConfig } from './config';
import { buildServer } from './server';

loadRootEnv();
const config = loadConfig();
const app = await buildServer(config);

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
if (config.engineOverride) app.log.warn({ engine: config.engineOverride }, 'engine override active');
