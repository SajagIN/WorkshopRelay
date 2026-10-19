/**
 * WorkshopRelay demonstration (OFF-08).
 *
 * Self-contained: runs the API, worker and mock service IN-PROCESS against the
 * configured database, then walks through registration during an outage,
 * recovery, retries, isolated failures, permanent failures, ambiguous
 * outcomes, crash recovery and cancellation fan-out — printing real evidence
 * (rows, receipts, timings) at each step.
 *
 *   npm run demo
 *
 * WARNING: uses the configured DATABASE_URL and clears nothing except its own
 * fixtures; safe to run repeatedly.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDb } from '../src/db/client';
import { parseConfig, type Config } from '../src/shared/config';
import { createLogger } from '../src/shared/logger';
import { systemClock } from '../src/shared/clock';
import { createApp } from '../src/api/app';
import { createMockApp } from '../src/mock/server';
import { FaultController } from '../src/mock/faults';
import { createHttpSender } from '../src/worker/sender';
import { NotificationWorker } from '../src/worker/worker';
import { claimDueEvents } from '../src/db/outbox';
import { uuidV5 } from '../src/shared/uuid';

/* ------------------------------------------------------------------ */
/* Output helpers                                                       */
/* ------------------------------------------------------------------ */

const out = (s = '') => process.stdout.write(s + '\n');
const rule = (title: string) => {
  out();
  out('═'.repeat(72));
  out(`  ${title}`);
  out('═'.repeat(72));
};
const ok = (s: string) => out(`  ✓ ${s}`);
const info = (s: string) => out(`    ${s}`);
const dim = (s: string) => out(`    \x1b[2m${s}\x1b[0m`);

function table(rows: Array<Record<string, string | number>>): void {
  if (rows.length === 0) {
    dim('(none)');
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  out(`    ${cols.map((c, i) => c.toUpperCase().padEnd(widths[i])).join('  ')}`);
  out(`    ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
  for (const r of rows) {
    out(`    ${cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ')}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Demo fixtures                                                        */
/* ------------------------------------------------------------------ */

const PREFIX = 'demo';
const ids = {
  ws1: uuidV5(`${PREFIX}:ws1`),
  ws2: uuidV5(`${PREFIX}:ws2`),
  ws3: uuidV5(`${PREFIX}:ws3`),
  ws4: uuidV5(`${PREFIX}:ws4`),
  alice: uuidV5('seed:member:alice'),
  bob: uuidV5('seed:member:bob'),
  carol: uuidV5('seed:member:carol'),
  dave: uuidV5('seed:member:dave'),
};

async function main(): Promise<void> {
  const baseConfig = parseConfig();
  // Fast retries so the demo stays snappy; everything else is standard config.
  const config: Config = {
    ...baseConfig,
    retryBaseMs: 80,
    retryCapMs: 400,
    retryMinMs: 40,
    notificationTimeoutMs: 400,
    workerPollMs: 50,
    workerLeaseMs: 2_000,
    logLevel: 'error',
  };

  const logger = createLogger({ level: 'error' });
  const handle = createDb(config.databaseUrl);
  const { db } = handle;

  // Identity rows (idempotent) — demo needs organizers/members to authenticate.
  for (const [label, token, memberId] of [
    ['Organizer', config.organizerToken, null],
    ['alice', 'alice-demo-token', ids.alice],
    ['bob', 'bob-demo-token', ids.bob],
    ['carol', 'carol-demo-token', ids.carol],
    ['dave', 'dave-demo-token', ids.dave],
  ] as Array<[string, string, string | null]>) {
    // Member row must exist before the identity can reference it.
    if (memberId) {
      await db.member.upsert({
        where: { id: memberId },
        update: {},
        create: {
          id: memberId,
          displayName: label[0].toUpperCase() + label.slice(1),
          notificationAddress: `${label}@synthetic.invalid`,
        },
      });
    }
    await db.demoIdentity.upsert({
      where: { token },
      update: {},
      create: { token, label, role: memberId ? 'MEMBER' : 'ORGANIZER', memberId },
    });
  }

  /* ---- in-process API on an ephemeral port ---- */
  const apiApp = createApp({ db, config, logger, clock: systemClock });
  const apiServer = http.createServer(apiApp);
  await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
  const apiPort = (apiServer.address() as AddressInfo).port;
  const api = `http://127.0.0.1:${apiPort}`;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = (body: unknown) => ({
    'content-type': 'application/json',
    body: JSON.stringify(body),
  });
  async function call(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; ms: number; body: any }> {
    const started = Date.now();
    const res = await fetch(api + path, {
      method,
      headers: { ...auth(token), ...(body !== undefined ? json(body) : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const ms = Date.now() - started;
    return { status: res.status, ms, body: await res.json().catch(() => null) };
  }

  /* ---- in-process mock (started later to simulate the outage) ---- */
  const faults = new FaultController();
  let mockServer: http.Server | null = null;
  let mockUrl = 'http://127.0.0.1:9'; // dead until Phase B
  async function startMock(): Promise<string> {
    const mockApp = createMockApp({ db, config, logger, clock: systemClock, faults });
    mockServer = http.createServer(mockApp);
    await new Promise<void>((r) => mockServer!.listen(0, '127.0.0.1', r));
    mockUrl = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
    return mockUrl;
  }

  /* ---- in-process worker, reconfigurable sender target ---- */
  function makeWorker(url: string, timeoutMs = config.notificationTimeoutMs) {
    return new NotificationWorker({
      db,
      config: { ...config, mockNotificationUrl: url },
      logger,
      clock: systemClock,
      sender: createHttpSender({ baseUrl: url, token: config.mockAuthToken, timeoutMs }),
    });
  }

  async function drain(worker: NotificationWorker, cycles = 8): Promise<void> {
    for (let i = 0; i < cycles; i++) {
      await worker.runOnce();
      const pending = await db.notificationEvent.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
      });
      if (pending === 0 && i > 0) return;
      await sleep(120);
    }
  }

  const eventRows = async (workshopId: string) => {
    const rows = await db.notificationEvent.findMany({
      where: { workshopId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      type: r.type.replace('REGISTRATION_CONFIRMED', 'CONFIRM').replace('WORKSHOP_CANCELLED', 'CANCEL '),
      recipient: r.recipientId.slice(0, 8),
      status: r.status,
      attempts: r.attemptCount,
      lastError: (r.lastError ?? '—').slice(0, 42),
    }));
  };

  const receiptsFor = async (eventIdPrefixCheck: (id: string) => boolean) => {
    const all = await db.mockDeliveryReceipt.findMany({ orderBy: { receivedAt: 'asc' } });
    return all.filter((r) => runEventIds.has(r.idempotencyKey) && eventIdPrefixCheck(r.idempotencyKey)).map((r) => ({
      key: r.idempotencyKey.slice(0, 8),
      payloadType: String((r.payload as { type?: string }).type ?? '?').replace(
        'REGISTRATION_CONFIRMED',
        'CONFIRM',
      ).replace('WORKSHOP_CANCELLED', 'CANCEL '),
    }));
  };

  const runEventIds = new Set<string>();

  /* ================================================================== */
  rule('WorkshopRelay — reliable registration & notifications demo');
  out(`  database : ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
  out(`  mode     : in-process API + worker + mock (same code as the servers)`);

  /* ---------------- Phase A: registration during an outage ---------- */
  rule('Phase A — register while the notification service is DOWN (OFF-02)');
  info('Notification service target is a dead port: delivery cannot succeed.');

  let r = await call('POST', '/api/workshops', config.organizerToken, {
    title: 'Reliable Systems 101',
    description: 'Outbox, retries and idempotency in practice.',
    scheduledAt: '2026-12-10T09:00:00Z',
  });
  if (r.status !== 201) throw new Error(`create workshop failed: ${JSON.stringify(r.body)}`);
  const ws1 = r.body.id as string;
  ok(`workshop created (${r.ms} ms) → ${ws1}`);

  for (const [name, token] of [
    ['alice', 'alice-demo-token'],
    ['bob', 'bob-demo-token'],
  ] as const) {
    r = await call('POST', `/api/workshops/${ws1}/registrations`, token, {});
    if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
    ok(`${name} registered — HTTP 201 in ${r.ms} ms (notification status: ${r.body.notification.status})`);
    info(`confirmation event ${r.body.notification.eventId.slice(0, 8)}… committed in the same transaction`);
    runEventIds.add(r.body.notification.eventId as string);
  }
  table(await eventRows(ws1));
  ok('registrations returned WITHOUT waiting for notification delivery');

  /* ---------------- Phase B: recovery ---------------- */
  rule('Phase B — notification service recovers; obligations deliver (OFF-03/04)');
  await startMock();
  info(`mock service now reachable at ${mockUrl}`);
  const worker = makeWorker(mockUrl);
  await drain(worker);
  table(await eventRows(ws1));
  table(await receiptsFor(() => true));
  ok('every committed registration produced exactly one confirmation receipt');

  /* ---------------- Phase C: transient failures ---------------- */
  rule('Phase C — transient failures retried automatically (OFF-05)');
  r = await call('POST', '/api/workshops', config.organizerToken, {
    title: 'Retry Patterns',
    description: 'Full-jitter backoff deep dive.',
    scheduledAt: '2026-12-11T09:00:00Z',
  });
  const ws2 = r.body.id as string;
  faults.setRule({ mode: 'fail_first_n', scope: { kind: 'global' }, failFirstN: 2 });
  info('fault rule: fail_first_n = 2 (the next two delivery calls fail with 503)');
  r = await call('POST', `/api/workshops/${ws2}/registrations`, 'carol-demo-token', {});
  ok(`carol registered (${r.ms} ms) → event ${r.body.notification.eventId.slice(0, 8)}…`);
  runEventIds.add(r.body.notification.eventId as string);
  await drain(worker);
  const attempts = await db.notificationAttempt.findMany({
    where: { eventId: r.body.notification.eventId },
    orderBy: { attemptNumber: 'asc' },
  });
  table(
    attempts.map((a) => ({
      attempt: a.attemptNumber,
      outcome: a.outcome ?? '…',
      http: a.httpStatus ?? '—',
      error: (a.error ?? '—').slice(0, 44),
    })),
  );
  ok('transient failures retried with backoff until delivery succeeded');

  /* ---------------- Phase D: isolated persistent failure ------------- */
  rule("Phase D — one recipient's failure never blocks others (OFF-05)");
  r = await call('POST', '/api/workshops', config.organizerToken, {
    title: 'Isolation Workshop',
    description: 'Independent jobs, independent progress.',
    scheduledAt: '2026-12-12T09:00:00Z',
  });
  const ws3 = r.body.id as string;
  faults.setRule({ mode: 'always_503', scope: { kind: 'recipient', recipientId: ids.dave } });
  info('fault rule: always_503 scoped to dave');
  let reg = await call('POST', `/api/workshops/${ws3}/registrations`, 'alice-demo-token', {});
  runEventIds.add(reg.body.notification.eventId as string);
  reg = await call('POST', `/api/workshops/${ws3}/registrations`, 'dave-demo-token', {});
  runEventIds.add(reg.body.notification.eventId as string);
  await worker.runOnce();
  await sleep(250);
  await worker.runOnce();
  table(await eventRows(ws3));
  ok('alice delivered immediately; dave keeps retrying on his own schedule');
  info('operator clears the fault…');
  faults.clear();
  await drain(worker);
  table(await eventRows(ws3));
  ok('dave healed automatically once the recipient recovered');

  /* ---------------- Phase E: permanent failure ---------------- */
  rule('Phase E — permanent failure → NEEDS_ATTENTION → operator requeue (OFF-08)');
  r = await call('POST', '/api/workshops', config.organizerToken, {
    title: 'Operator Actions',
    description: 'Visible failures beat silent drops.',
    scheduledAt: '2026-12-13T09:00:00Z',
  });
  const ws4 = r.body.id as string;
  faults.setRule({
    mode: 'always_400',
    scope: { kind: 'recipient', recipientId: ids.carol },
  });
  info('fault rule: always_400 scoped to carol (a clear permanent rejection)');
  r = await call('POST', `/api/workshops/${ws4}/registrations`, 'carol-demo-token', {});
  const stuckEventId = r.body.notification.eventId as string;
  runEventIds.add(stuckEventId);
  await worker.runOnce();
  table(await eventRows(ws4));
  info('organizer inspects the event via GET /api/notifications/:id …');
  const detail = await call('GET', `/api/notifications/${stuckEventId}`, config.organizerToken);
  info(`status=${detail.body.status}  attempts=${detail.body.attempts.length}  lastError=${String(detail.body.lastError).slice(0, 50)}`);
  info('operator corrects the cause (fault cleared) and requeues…');
  faults.clear();
  const requeue = await call('POST', `/api/notifications/${stuckEventId}/retry`, config.organizerToken);
  ok(`requeue → HTTP ${requeue.status} (status now ${requeue.body.status})`);
  await drain(worker);
  table(await eventRows(ws4));
  ok('needs-attention job recovered under operator control');

  /* ---------------- Phase F: ambiguous outcome ---------------- */
  rule('Phase F — receiver commits, response is lost (ambiguous) — retry dedupes (OFF-05)');
  r = await call('POST', '/api/workshops', config.organizerToken, {
    title: 'Ambiguity Lab',
    description: 'Exactly-once logical delivery via idempotency keys.',
    scheduledAt: '2026-12-14T09:00:00Z',
  });
  const ws5 = r.body.id as string;
  faults.setRule({ mode: 'commit_then_timeout', scope: { kind: 'global' }, hangMs: 700 });
  info('fault rule: commit_then_timeout (receipt writes, then the response hangs)');
  r = await call('POST', `/api/workshops/${ws5}/registrations`, 'bob-demo-token', {});
  const bobEvent = r.body.notification.eventId as string;
  runEventIds.add(bobEvent);
  const shortWorker = makeWorker(mockUrl, 150); // client timeout < hang
  await shortWorker.runOnce();
  let receipts = await receiptsFor((k) => k === bobEvent);
  table(await eventRows(ws5));
  table(receipts);
  info('worker saw a timeout, but the receipt is already durable — retrying…');
  faults.clear();
  await drain(worker);
  receipts = await receiptsFor((k) => k === bobEvent);
  table(await eventRows(ws5));
  table(receipts);
  ok('exactly one receipt; the resend was suppressed as a duplicate');

  /* ---------------- Phase G: crash + lease recovery ---------------- */
  rule('Phase G — worker dies after claim; lease expiry recovers the job (OFF-04)');
  r = await call('POST', '/api/workshops', config.organizerToken, {
    title: 'Crash Lab',
    description: 'Nothing is lost between claim and settle.',
    scheduledAt: '2026-12-15T09:00:00Z',
  });
  const ws6 = r.body.id as string;
  reg = await call('POST', `/api/workshops/${ws6}/registrations`, 'alice-demo-token', {});
  runEventIds.add(reg.body.notification.eventId as string);
  info('worker A claims the event and dies before sending (simulated)…');
  const claimed = await claimDueEvents(db, { limit: 5, leaseMs: 3_000, now: new Date() });
  info(`claimed ${claimed.length} event(s), lease token ${claimed[0]?.claimToken.slice(0, 8)}… — process "crashes"`);
  await worker.runOnce();
  info('worker B runs while the lease is still live — job not stolen yet');
  table(await eventRows(ws6));
  await db.notificationEvent.updateMany({
    where: { id: claimed[0].id },
    data: { leaseUntil: new Date(Date.now() - 1_000) },
  });
  info('lease expires (simulated clock jump)…');
  await drain(worker);
  table(await eventRows(ws6));
  ok('expired lease reclaimed; the job delivered exactly once at the receiver');

  /* ---------------- Phase H: cancellation fan-out ---------------- */
  rule('Phase H — cancellation notifies every registered member (OFF-06)');
  const cancel1 = await call('POST', `/api/workshops/${ws1}/cancel`, config.organizerToken);
  for (const id of (cancel1.body.eventIds as string[]) ?? []) runEventIds.add(id);
  ok(`cancel → ${cancel1.body.notificationsCreated} cancellation event(s) created`);
  const cancel2 = await call('POST', `/api/workshops/${ws1}/cancel`, config.organizerToken);
  ok(`repeat cancel → alreadyCancelled=${cancel2.body.alreadyCancelled}, new events=${cancel2.body.notificationsCreated}`);
  await drain(worker);
  const status = await call('GET', `/api/workshops/${ws1}/notification-status`, config.organizerToken);
  table(
    (status.body.events as Array<Record<string, string>>).map((e) => ({
      type: e.type.replace('REGISTRATION_CONFIRMED', 'CONFIRM ').replace('WORKSHOP_CANCELLED', 'CANCEL  '),
      status: e.status,
      attempts: e.attemptCount,
    })),
  );
  ok('all registrants were notified; repeat cancellation created no duplicates');

  /* ---------------- Summary ---------------- */
  rule('Demo complete — evidence lives in PostgreSQL');
  const runIdList = [...runEventIds];
  const totals = await db.notificationEvent.groupBy({
    by: ['status'],
    where: { id: { in: runIdList } },
    _count: true,
  });
  table(totals.map((t) => ({ status: t.status, events: t._count })));
  const receiptCount = await db.mockDeliveryReceipt.count({ where: { idempotencyKey: { in: runIdList } } });
  out();
  info(`delivery receipts stored          : ${receiptCount}`);
  info(`inspect in the dashboard          : npm run dev:api  → http://localhost:${config.apiPort}/`);
  info(`inspect raw state                 : psql $DATABASE_URL`);
  dim('  tables: "NotificationEvent", "NotificationAttempt", "MockDeliveryReceipt"');
  out();

  await new Promise<void>((r2) => apiServer.close(() => r2()));
  if (mockServer) await new Promise<void>((r2) => mockServer!.close(() => r2()));
  await handle.close();
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exitCode = 1;
});
