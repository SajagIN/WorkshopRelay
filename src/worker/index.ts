/**
 * Worker process entrypoint.
 */
import { createDb } from '../db/client';
import { parseConfig } from '../shared/config';
import { createLogger } from '../shared/logger';
import { systemClock } from '../shared/clock';
import { createHttpSender } from './sender';
import { NotificationWorker } from './worker';

const config = parseConfig();
const logger = createLogger({ level: config.logLevel, base: { component: 'worker' } });
const handle = createDb(config.databaseUrl);

const sender = createHttpSender({
  baseUrl: config.mockNotificationUrl,
  token: config.mockAuthToken,
  timeoutMs: config.notificationTimeoutMs,
});

const worker = new NotificationWorker({
  db: handle.db,
  config,
  logger,
  clock: systemClock,
  sender,
});

worker.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down worker', { signal });
  // Stop claiming; in-flight cycles settle their jobs (or their leases expire
  // and a later worker reclaims them — either way nothing is lost).
  await worker.stop();
  await handle.close();
  logger.info('Worker shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
