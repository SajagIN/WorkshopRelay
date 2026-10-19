/**
 * API process entrypoint. Binds to 0.0.0.0 for preview/deployment use.
 */
import { createDb } from '../db/client';
import { parseConfig } from '../shared/config';
import { createLogger } from '../shared/logger';
import { systemClock } from '../shared/clock';
import { createApp } from './app';

const config = parseConfig();
const logger = createLogger({ level: config.logLevel, base: { component: 'api' } });
const handle = createDb(config.databaseUrl);

const app = createApp({
  db: handle.db,
  config,
  logger,
  clock: systemClock,
});

const server = app.listen(config.apiPort, config.apiHost, () => {
  logger.info('API listening', {
    host: config.apiHost,
    port: config.apiPort,
    dashboard: `http://${config.apiHost}:${config.apiPort}/`,
  });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down API', { signal });
  server.close(async () => {
    await handle.close();
    logger.info('API shutdown complete');
    process.exit(0);
  });
  // Safety net if close hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
