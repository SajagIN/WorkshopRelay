/**
 * Shared test context: real PostgreSQL (test database), in-process API / mock /
 * worker, fast retry timings, silent logger, fake clock support.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type { Db, DbHandle } from '../../src/db/client';
import { createDb } from '../../src/db/client';
import { parseConfig, type Config } from '../../src/shared/config';
import { createSilentLogger, type Logger } from '../../src/shared/logger';
import { createFakeClock, systemClock, type Clock } from '../../src/shared/clock';
import { createApp, type AppContext } from '../../src/api/app';
import { createMockApp } from '../../src/mock/server';
import { FaultController } from '../../src/mock/faults';
import { createHttpSender, type NotificationSender } from '../../src/worker/sender';
import { NotificationWorker } from '../../src/worker/worker';
import type { EventPayload, NotificationEventType } from '../../src/domain/types';
import { PAYLOAD_VERSION } from '../../src/domain/types';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  'postgresql://workshop:workshop_dev_password@127.0.0.1:5432/workshop_relay_test';

export interface TestConfigOverrides {
  [key: string]: string | number | boolean | undefined;
}

/** Fast, deterministic-ish timings for tests. */
export function makeTestConfig(overrides: TestConfigOverrides = {}): Config {
  return parseConfig({
    DATABASE_URL: TEST_DATABASE_URL,
    NOTIFICATION_TIMEOUT_MS: '300',
    RETRY_BASE_MS: '20',
    RETRY_CAP_MS: '100',
    RETRY_MIN_MS: '5',
    RETRY_AFTER_MAX_MS: '250',
    RETRY_ALERT_AFTER_ATTEMPTS: '5',
    WORKER_POLL_MS: '25',
    WORKER_LEASE_MS: '400',
    WORKER_BATCH_SIZE: '10',
    WORKER_CONCURRENCY: '5',
    ENABLE_DEMO_FAULTS: 'true',
    ENABLE_DEMO_PERSONAS: 'true',
    LOG_LEVEL: 'error',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface TestContext extends AppContext {
  handle: DbHandle;
  config: Config;
  db: Db;
  logger: Logger;
  clock: Clock;
}

export function createTestContext(overrides: TestConfigOverrides = {}, fakeClock = false): TestContext {
  const config = makeTestConfig(overrides);
  const handle = createDb(TEST_DATABASE_URL, 10);
  const logger = createSilentLogger();
  const clock = fakeClock ? createFakeClock() : systemClock;
  return { db: handle.db, config, logger, clock, handle };
}

export async function truncateAll(db: Db): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "NotificationAttempt",
      "NotificationEvent",
      "Registration",
      "Workshop",
      "MockDeliveryReceipt",
      "WorkerHeartbeat",
      "DemoIdentity",
      "Member"
    CASCADE
  `);
}

// ---------------------------------------------------------------------------
// Mock service on an ephemeral port
// ---------------------------------------------------------------------------

export interface RunningMock {
  url: string;
  port: number;
  faults: FaultController;
  close(): Promise<void>;
}

export async function startMock(ctx: TestContext): Promise<RunningMock> {
  const faults = new FaultController();
  const app = createMockApp({ ...ctx, faults });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    faults,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Destroy keep-alive sockets so close() can finish promptly.
        server.closeAllConnections?.();
      }),
  };
}

// ---------------------------------------------------------------------------
// API app + worker
// ---------------------------------------------------------------------------

export function makeApp(ctx: TestContext): Express {
  return createApp(ctx);
}

export interface TestWorkerBundle {
  worker: NotificationWorker;
  sender: NotificationSender;
}

export function makeWorker(
  ctx: TestContext,
  opts: { mockUrl: string; workerId?: string; timeoutMs?: number; random?: () => number },
): TestWorkerBundle {
  const config: Config = {
    ...ctx.config,
    workerId: opts.workerId ?? ctx.config.workerId,
    mockNotificationUrl: opts.mockUrl,
  };
  const sender = createHttpSender({
    baseUrl: opts.mockUrl,
    token: config.mockAuthToken,
    timeoutMs: opts.timeoutMs ?? config.notificationTimeoutMs,
  });
  const worker = new NotificationWorker({
    db: ctx.db,
    config,
    logger: ctx.logger,
    clock: ctx.clock,
    sender,
    random: opts.random,
  });
  return { worker, sender };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface TestMember {
  id: string;
  displayName: string;
  notificationAddress: string;
  token: string;
}

export async function makeMember(
  ctx: TestContext,
  label: string,
  token = `test-${label}-token`,
): Promise<TestMember> {
  const id = `member-${label}-${Math.random().toString(36).slice(2, 10)}`;
  await ctx.db.member.create({
    data: {
      id,
      displayName: `Test ${label}`,
      notificationAddress: `${label}@synthetic.invalid`,
    },
  });
  await ctx.db.demoIdentity.create({
    data: { token, label, role: 'MEMBER', memberId: id },
  });
  return {
    id,
    displayName: `Test ${label}`,
    notificationAddress: `${label}@synthetic.invalid`,
    token,
  };
}

export async function makeOrganizer(ctx: TestContext, token = 'test-organizer-token'): Promise<void> {
  await ctx.db.demoIdentity.upsert({
    where: { token },
    update: { label: 'Test Organizer', role: 'ORGANIZER', memberId: null },
    create: { token, label: 'Test Organizer', role: 'ORGANIZER', memberId: null },
  });
}

export async function makeWorkshop(
  ctx: TestContext,
  title = 'Test Workshop',
): Promise<{ id: string }> {
  const id = `workshop-${Math.random().toString(36).slice(2, 12)}`;
  await ctx.db.workshop.create({
    data: {
      id,
      title,
      description: 'test',
      scheduledAt: new Date('2026-12-01T10:00:00Z'),
      status: 'ACTIVE',
      createdBy: 'Test Organizer',
    },
  });
  return { id };
}

/** Insert an outbox event directly (for worker-level tests). */
export async function makeEvent(
  ctx: TestContext,
  opts: {
    recipientId: string;
    workshopId: string;
    type?: NotificationEventType;
    dedupeKey?: string;
    payload?: EventPayload;
    status?: 'PENDING' | 'PROCESSING' | 'NEEDS_ATTENTION';
    nextAttemptAt?: Date;
  },
): Promise<{ id: string }> {
  const id = `event-${Math.random().toString(36).slice(2, 12)}`;
  const payload: EventPayload = opts.payload ?? {
    payloadVersion: PAYLOAD_VERSION,
    message: {
      workshopId: opts.workshopId,
      title: 'Test Workshop',
      scheduledAt: '2026-12-01T10:00:00Z',
      memberId: opts.recipientId,
      memberName: 'Test',
      notificationAddress: 'test@synthetic.invalid',
      registeredAt: '2026-11-01T00:00:00.000Z',
    },
  };
  await ctx.db.notificationEvent.create({
    data: {
      id,
      dedupeKey: opts.dedupeKey ?? `test:${id}`,
      type: opts.type ?? 'REGISTRATION_CONFIRMED',
      recipientId: opts.recipientId,
      workshopId: opts.workshopId,
      payload: payload as object,
      status: opts.status ?? 'PENDING',
      attemptCount: 0,
      nextAttemptAt: opts.nextAttemptAt ?? new Date('2020-01-01T00:00:00Z'),
    },
  });
  return { id };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until truthy or timeout. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
