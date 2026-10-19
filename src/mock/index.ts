/**
 * Mock notification service entrypoint.
 */
import { createDb } from '../db/client';
import { parseConfig } from '../shared/config';
import { createLogger } from '../shared/logger';
import { systemClock } from '../shared/clock';
import { FaultController } from './faults';
import { createMockApp } from './server';

const config = parseConfig();
const logger = createLogger({ level: config.logLevel, base: { component: 'mock' } });
const handle = createDb(config.databaseUrl);

const app = createMockApp({
  db: handle.db,
  config,
  logger,
  clock: systemClock,
  faults: new FaultController(),
});

const server = app.listen(config.mockPort, config.mockHost, () => {
  logger.info('Mock notification service listening', {
    host: config.mockHost,
    port: config.mockPort,
    demoFaults: config.enableDemoFaults,
  });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down mock service', { signal });
  server.close(async () => {
    await handle.close();
    logger.info('Mock service shutdown complete');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
