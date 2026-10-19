/**
 * End-to-end failure scenarios (PRD §12, OFF-02 … OFF-08).
 *
 * Real API (supertest) + real in-process worker + real in-process mock service
 * against real PostgreSQL. Crash windows are simulated exactly as documented
 * in PRD §9: a process dies between two durable steps, and recovery is
 * asserted on the surviving state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  createTestContext,
  makeApp,
  makeMember,
  makeOrganizer,
  makeWorker,
  startMock,
  truncateAll,
  waitFor,
  type RunningMock,
  type TestContext,
  type TestMember,
} from '../helpers/context';
import { claimDueEvents } from '../../src/db/outbox';

const ORG = 'test-organizer-token';

describe('e2e failure scenarios', () => {
  let ctx: TestContext;
  let app: Express;
  let mock: RunningMock;

  beforeAll(async () => {
    ctx = createTestContext();
    app = makeApp(ctx);
    mock = await startMock(ctx);
    await makeOrganizer(ctx, ORG);
  });

  afterAll(async () => {
    await mock.close();
    await ctx.handle.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
    await makeOrganizer(ctx, ORG);
    mock.faults.clear();
  });

  async function createWorkshopViaApi(title = 'E2E Workshop'): Promise<string> {
    const res = await request(app)
      .post('/api/workshops')
      .set('Authorization', `Bearer ${ORG}`)
      .send({ title, description: 'e2e', scheduledAt: '2026-12-01T10:00:00Z' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function registerViaApi(workshop: string, token: string): Promise<void> {
    const res = await request(app)
      .post(`/api/workshops/${workshop}/registrations`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status, `registration should succeed: ${JSON.stringify(res.body)}`).toBe(201);
  }

  // -------------------------------------------------------------------------
  // OFF-02 / OFF-03 / OFF-04 — mock outage during registration
  // -------------------------------------------------------------------------

  it('OFF-02: registration returns immediately with the notification service down', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();

    // Worker sender pointed at a dead port — delivery cannot possibly succeed.
    const deadUrl = 'http://127.0.0.1:9';
    const { worker } = makeWorker(ctx, { mockUrl: deadUrl, timeoutMs: 200 });

    const started = Date.now();
    const res = await request(app)
      .post(`/api/workshops/${workshop}/registrations`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({});
    const elapsedMs = Date.now() - started;

    expect(res.status).toBe(201);
    expect(res.body.notification.status).toBe('PENDING');
    // The response must NOT wait for notification delivery: the sender's
    // timeout is 200ms here and would block far longer if the request path
    // touched the network. (Strict latency observations — 25ms/21ms on the
    // recording machine — are captured in docs/demo-results.md.)
    expect(elapsedMs).toBeLessThan(1_000);

    // OFF-03: the committed registration has a durable confirmation obligation.
    const events = await ctx.db.notificationEvent.findMany({
      where: { workshopId: workshop, type: 'REGISTRATION_CONFIRMED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('PENDING');

    // OFF-04: nothing is lost while the outage continues; attempts retry.
    await worker.runOnce();
    const after = await ctx.db.notificationEvent.findFirstOrThrow({
      where: { workshopId: workshop },
    });
    expect(after.status).toBe('PENDING');
    expect(after.attemptCount).toBe(1);
    expect(after.lastError).toBeTruthy();

    // Recovery: mock reachable again → the same event delivers.
    const { worker: recovered } = makeWorker(ctx, { mockUrl: mock.url });
    await waitFor(async () => {
      // allow any retry backoff to elapse
      await ctx.db.notificationEvent.updateMany({
        where: { id: after.id },
        data: { nextAttemptAt: new Date() },
      });
      await recovered.runOnce();
      const row = await ctx.db.notificationEvent.findUniqueOrThrow({ where: { id: after.id } });
      return row.status === 'DELIVERED' ? row : null;
    });
  });

  it('OFF-03: failed registration creates no confirmation', async () => {
    const workshop = await createWorkshopViaApi();
    const res = await request(app)
      .post(`/api/workshops/${workshop}/registrations`)
      .set('Authorization', `Bearer ${ORG}`) // organizer has no member profile
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_MEMBER');
    expect(await ctx.db.notificationEvent.count()).toBe(0);
    expect(await ctx.db.registration.count()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // OFF-05 — retry with independent progress
  // -------------------------------------------------------------------------

  it('OFF-05: first N calls fail, then delivery recovers via retry', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    mock.faults.setRule({ mode: 'fail_first_n', scope: { kind: 'global' }, failFirstN: 2 });

    await registerViaApi(workshop, member.token);

    const { worker } = makeWorker(ctx, { mockUrl: mock.url });
    await worker.runOnce(); // attempt 1 → 503
    await worker.runOnce(); // (likely not due yet) — force due time
    await ctx.db.notificationEvent.updateMany({ where: {}, data: { nextAttemptAt: new Date() } });
    await worker.runOnce(); // attempt 2 → 503
    await ctx.db.notificationEvent.updateMany({ where: {}, data: { nextAttemptAt: new Date() } });
    await worker.runOnce(); // attempt 3 → success

    const event = await ctx.db.notificationEvent.findFirstOrThrow({
      where: { workshopId: workshop },
    });
    expect(event.status).toBe('DELIVERED');
    expect(event.attemptCount).toBeGreaterThanOrEqual(2);
    const attempts = await ctx.db.notificationAttempt.findMany({
      where: { eventId: event.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts[0].outcome).toBe('RETRY_SCHEDULED');
    expect(attempts[attempts.length - 1].outcome).toBe('SUCCESS');
  });

  it('OFF-05: persistent failure for one recipient does not block others', async () => {
    const failing = await makeMember(ctx, 'failing', 'e2e-failing-token');
    const healthy = await makeMember(ctx, 'healthy', 'e2e-healthy-token');
    const workshop = await createWorkshopViaApi();

    mock.faults.setRule({
      mode: 'always_503',
      scope: { kind: 'recipient', recipientId: failing.id },
    });

    await registerViaApi(workshop, failing.token);
    await registerViaApi(workshop, healthy.token);

    const { worker } = makeWorker(ctx, { mockUrl: mock.url });
    await worker.runOnce();

    const events = await ctx.db.notificationEvent.findMany({ where: { workshopId: workshop } });
    const failingEvent = events.find((e) => e.recipientId === failing.id)!;
    const healthyEvent = events.find((e) => e.recipientId === healthy.id)!;
    expect(healthyEvent.status).toBe('DELIVERED');
    expect(failingEvent.status).toBe('PENDING'); // still retrying, never dropped

    // Operator clears the fault → the stuck job heals on its own.
    mock.faults.clear();
    await ctx.db.notificationEvent.updateMany({ where: {}, data: { nextAttemptAt: new Date() } });
    await worker.runOnce();
    const healed = await ctx.db.notificationEvent.findUniqueOrThrow({
      where: { id: failingEvent.id },
    });
    expect(healed.status).toBe('DELIVERED');
  });

  // -------------------------------------------------------------------------
  // Ambiguous outcomes
  // -------------------------------------------------------------------------

  it('timeout before receiver commit: no receipt, retry succeeds', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    mock.faults.setRule({
      mode: 'timeout_before_commit',
      scope: { kind: 'global' },
      hangMs: 600,
    });
    await registerViaApi(workshop, member.token);

    const { worker } = makeWorker(ctx, { mockUrl: mock.url, timeoutMs: 150 });
    await worker.runOnce();

    const event = await ctx.db.notificationEvent.findFirstOrThrow({
      where: { workshopId: workshop },
    });
    expect(event.status).toBe('PENDING');
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(0); // never committed

    mock.faults.clear();
    await ctx.db.notificationEvent.updateMany({ where: {}, data: { nextAttemptAt: new Date() } });
    await worker.runOnce();
    const done = await ctx.db.notificationEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(done.status).toBe('DELIVERED');
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
  });

  it('commit then timeout: receipt exists; retry dedupes to one receipt (OFF-05 ambiguity)', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    mock.faults.setRule({
      mode: 'commit_then_timeout',
      scope: { kind: 'global' },
      hangMs: 600,
    });
    await registerViaApi(workshop, member.token);

    const { worker } = makeWorker(ctx, { mockUrl: mock.url, timeoutMs: 150 });
    await worker.runOnce(); // times out after the receipt commits

    const event = await ctx.db.notificationEvent.findFirstOrThrow({
      where: { workshopId: workshop },
    });
    expect(event.status).toBe('PENDING'); // ambiguous from the worker's view
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1); // but delivered!

    mock.faults.clear();
    await ctx.db.notificationEvent.updateMany({ where: {}, data: { nextAttemptAt: new Date() } });
    await worker.runOnce();
    const done = await ctx.db.notificationEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(done.status).toBe('DELIVERED');
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1); // duplicate suppressed
  });

  // -------------------------------------------------------------------------
  // Kill/crash windows (OFF-04)
  // -------------------------------------------------------------------------

  it('kill after claim: lease expiry lets another worker deliver', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    await registerViaApi(workshop, member.token);

    // Worker A claims… and dies (no settle).
    const claimed = await claimDueEvents(ctx.db, { limit: 5, leaseMs: 60_000, now: new Date() });
    expect(claimed).toHaveLength(1);

    // Its lease is still live — worker B cannot steal the job yet.
    const { worker: workerB } = makeWorker(ctx, { mockUrl: mock.url });
    await workerB.runOnce();
    let event = await ctx.db.notificationEvent.findFirstOrThrow({
      where: { workshopId: workshop },
    });
    expect(event.status).toBe('PROCESSING');

    // Lease expires (simulated clock jump past leaseUntil).
    await ctx.db.notificationEvent.updateMany({
      where: { id: event.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    await workerB.runOnce();
    event = await ctx.db.notificationEvent.findFirstOrThrow({ where: { workshopId: workshop } });
    expect(event.status).toBe('DELIVERED');
    expect(event.attemptCount).toBe(2);

    // The dead worker's attempt is visibly stale, not silently wrong.
    const attempts = await ctx.db.notificationAttempt.findMany({
      where: { eventId: event.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts).toHaveLength(2);
  });

  it('kill after receiver success: resend is deduplicated at the receiver', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    await registerViaApi(workshop, member.token);

    const claimed = await claimDueEvents(ctx.db, { limit: 5, leaseMs: 60_000, now: new Date() });
    expect(claimed).toHaveLength(1);
    const { sender } = makeWorker(ctx, { mockUrl: mock.url });
    const { buildDeliveryBody } = await import('../../src/domain/events');
    const stored = await ctx.db.notificationEvent.findUniqueOrThrow({
      where: { id: claimed[0].id },
    });
    const outcome = await sender.send(
      buildDeliveryBody(
        stored.id,
        stored.type,
        stored.recipientId,
        stored.payload as unknown as import('../../src/domain/types').EventPayload,
      ),
      stored.id,
    );
    expect(outcome.kind).toBe('success');
    // …worker dies here, before markDelivered.

    await ctx.db.notificationEvent.updateMany({
      where: { id: stored.id },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const { worker: workerB } = makeWorker(ctx, { mockUrl: mock.url });
    await workerB.runOnce();

    const event = await ctx.db.notificationEvent.findUniqueOrThrow({ where: { id: stored.id } });
    expect(event.status).toBe('DELIVERED');
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
  });

  it('mock restart keeps receipts durable (duplicate suppression survives)', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    await registerViaApi(workshop, member.token);

    const { worker } = makeWorker(ctx, { mockUrl: mock.url });
    await worker.runOnce();
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);

    // "Restart" the mock service on a fresh port with the same database.
    const restarted = await startMock(ctx);
    try {
      // Resend the same event id at the restarted service.
      const { sender } = makeWorker(ctx, { mockUrl: restarted.url });
      const { buildDeliveryBody } = await import('../../src/domain/events');
      const stored = await ctx.db.notificationEvent.findFirstOrThrow({
        where: { workshopId: workshop },
      });
      const outcome = await sender.send(
        buildDeliveryBody(
          stored.id,
          stored.type,
          stored.recipientId,
          stored.payload as unknown as import('../../src/domain/types').EventPayload,
        ),
        stored.id,
      );
      expect(outcome.kind).toBe('success');
      expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
    } finally {
      await restarted.close();
    }
  });

  // -------------------------------------------------------------------------
  // Operator tooling — NEEDS_ATTENTION + requeue (OFF-08)
  // -------------------------------------------------------------------------

  it('permanent failure → NEEDS_ATTENTION → corrected → manual requeue delivers', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    mock.faults.setRule({ mode: 'always_400', scope: { kind: 'global' } });
    await registerViaApi(workshop, member.token);

    const { worker } = makeWorker(ctx, { mockUrl: mock.url });
    await worker.runOnce();

    const event = await ctx.db.notificationEvent.findFirstOrThrow({
      where: { workshopId: workshop },
    });
    expect(event.status).toBe('NEEDS_ATTENTION');

    // Organizer inspects the event through the API.
    const detail = await request(app)
      .get(`/api/notifications/${event.id}`)
      .set('Authorization', `Bearer ${ORG}`);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('NEEDS_ATTENTION');
    expect(detail.body.attempts.length).toBeGreaterThan(0);

    // Requeue before fixing the cause would just fail again — the cause is
    // corrected first (fault cleared), then the organizer requeues.
    mock.faults.clear();
    const requeue = await request(app)
      .post(`/api/notifications/${event.id}/retry`)
      .set('Authorization', `Bearer ${ORG}`);
    expect(requeue.status).toBe(200);
    expect(requeue.body.status).toBe('PENDING');

    await worker.runOnce();
    const done = await ctx.db.notificationEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(done.status).toBe('DELIVERED');
  });

  it('requeue is rejected for events that are not NEEDS_ATTENTION', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const workshop = await createWorkshopViaApi();
    await registerViaApi(workshop, member.token);
    const event = await ctx.db.notificationEvent.findFirstOrThrow({
      where: { workshopId: workshop },
    });

    const res = await request(app)
      .post(`/api/notifications/${event.id}/retry`)
      .set('Authorization', `Bearer ${ORG}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_NEEDS_ATTENTION');
  });

  // -------------------------------------------------------------------------
  // API contract basics
  // -------------------------------------------------------------------------

  it('error envelope carries code, message and requestId', async () => {
    const res = await request(app).get('/api/workshops');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('demo persona listing is public; whoami requires auth', async () => {
    await makeMember(ctx, 'alice', 'e2e-alice-token');

    const personas = await request(app).get('/api/demo/personas');
    expect(personas.status).toBe(200);
    expect(Array.isArray(personas.body.personas)).toBe(true);
    expect(personas.body.personas.length).toBeGreaterThanOrEqual(2);

    const anon = await request(app).get('/api/demo/whoami');
    expect(anon.status).toBe(401);

    const authed = await request(app)
      .get('/api/demo/whoami')
      .set('Authorization', `Bearer ${ORG}`);
    expect(authed.status).toBe(200);
    expect(authed.body.role).toBe('ORGANIZER');
  });

  it('validates input with 400 + details', async () => {
    const res = await request(app)
      .post('/api/workshops')
      .set('Authorization', `Bearer ${ORG}`)
      .send({ title: '', scheduledAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('enforces roles: members cannot create workshops or view rosters', async () => {
    const member = await makeMember(ctx, 'alice', 'e2e-alice-token');
    const create = await request(app)
      .post('/api/workshops')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ title: 'X', scheduledAt: '2026-12-01T10:00:00Z' });
    expect(create.status).toBe(403);

    const workshop = await createWorkshopViaApi();
    const roster = await request(app)
      .get(`/api/workshops/${workshop}/registrations`)
      .set('Authorization', `Bearer ${member.token}`);
    expect(roster.status).toBe(403);
  });

  it('cancellation fan-out reaches all members and is idempotent through the API', async () => {
    const workshop = await createWorkshopViaApi();
    const members: TestMember[] = [];
    for (const label of ['a', 'b', 'c']) {
      const m = await makeMember(ctx, label, `e2e-${label}-token`);
      members.push(m);
      await request(app)
        .post(`/api/workshops/${workshop}/registrations`)
        .set('Authorization', `Bearer ${m.token}`)
        .send({});
    }

    const { worker } = makeWorker(ctx, { mockUrl: mock.url });
    await worker.runOnce(); // deliver confirmations

    const cancel = await request(app)
      .post(`/api/workshops/${workshop}/cancel`)
      .set('Authorization', `Bearer ${ORG}`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.notificationsCreated).toBe(3);

    const repeat = await request(app)
      .post(`/api/workshops/${workshop}/cancel`)
      .set('Authorization', `Bearer ${ORG}`);
    expect(repeat.status).toBe(200);
    expect(repeat.body.alreadyCancelled).toBe(true);
    expect(repeat.body.notificationsCreated).toBe(0);

    await ctx.db.notificationEvent.updateMany({ where: {}, data: { nextAttemptAt: new Date() } });
    await worker.runOnce();

    const status = await request(app)
      .get(`/api/workshops/${workshop}/notification-status`)
      .set('Authorization', `Bearer ${ORG}`);
    expect(status.status).toBe(200);
    const delivered = status.body.events.filter(
      (e: { status: string }) => e.status === 'DELIVERED',
    );
    expect(delivered).toHaveLength(6); // 3 confirmations + 3 cancellations
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(6);
  });
});
