/**
 * Integration: worker claim/lease/fencing/retry behavior against real
 * PostgreSQL (OFF-04, OFF-05, crash-window recovery).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  makeEvent,
  makeMember,
  makeWorker,
  makeWorkshop,
  startMock,
  truncateAll,
  type RunningMock,
  type TestContext,
} from '../helpers/context';
import {
  claimDueEvents,
  markDelivered,
  settleRetry,
} from '../../src/db/outbox';
import type { NotificationSender } from '../../src/worker/sender';
import type { SendOutcome } from '../../src/domain/retryPolicy';

function scriptedSender(
  script: (body: { eventId: string; recipientId: string }, attempt: number) => SendOutcome,
): NotificationSender & { calls: Array<{ eventId: string; attempt: number }> } {
  const calls: Array<{ eventId: string; attempt: number }> = [];
  const seen = new Map<string, number>();
  return {
    calls,
    async send(body) {
      const attempt = (seen.get(body.eventId) ?? 0) + 1;
      seen.set(body.eventId, attempt);
      calls.push({ eventId: body.eventId, attempt });
      return script(body, attempt);
    },
  };
}

describe('worker claim protocol', () => {
  let ctx: TestContext;

  beforeAll(() => {
    ctx = createTestContext();
  });

  afterAll(async () => {
    await ctx.handle.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  it('claims due events, sets lease + fresh token, creates attempt row atomically', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const claimed = await claimDueEvents(ctx.db, {
      limit: 10,
      leaseMs: 5000,
      now: new Date(),
    });
    expect(claimed).toHaveLength(1);
    const event = claimed[0];
    expect(event.id).toBe(id);
    expect(event.status).toBe('PROCESSING');
    expect(event.claimToken).toBeTruthy();
    expect(event.attemptCount).toBe(1);
    expect(event.leaseUntil).not.toBeNull();

    const attempts = await ctx.db.notificationAttempt.findMany({ where: { eventId: id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].startedAt).not.toBeNull();
  });

  it('does not claim future-scheduled events', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    await makeEvent(ctx, {
      recipientId: member.id,
      workshopId: workshop.id,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    const claimed = await claimDueEvents(ctx.db, { limit: 10, leaseMs: 5000, now: new Date() });
    expect(claimed).toHaveLength(0);
  });

  it('competing workers never claim the same row (SKIP LOCKED)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    for (let i = 0; i < 6; i++) {
      await makeEvent(ctx, {
        recipientId: member.id,
        workshopId: workshop.id,
        dedupeKey: `test:batch:${i}`,
      });
    }

    const [a, b, c] = await Promise.all([
      claimDueEvents(ctx.db, { limit: 5, leaseMs: 5000, now: new Date() }),
      claimDueEvents(ctx.db, { limit: 5, leaseMs: 5000, now: new Date() }),
      claimDueEvents(ctx.db, { limit: 5, leaseMs: 5000, now: new Date() }),
    ]);
    const ids = [...a, ...b, ...c].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(6);
  });

  it('reclaims PROCESSING events whose lease expired (OFF-04)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const [first] = await claimDueEvents(ctx.db, { limit: 1, leaseMs: 50, now: new Date() });
    expect(first.id).toBe(id);

    // While the lease is live, a second claim sees nothing.
    const empty = await claimDueEvents(ctx.db, { limit: 5, leaseMs: 5000, now: new Date() });
    expect(empty).toHaveLength(0);

    // After lease expiry, the job is reclaimable with a NEW token.
    await new Promise((r) => setTimeout(r, 80));
    const [second] = await claimDueEvents(ctx.db, { limit: 5, leaseMs: 5000, now: new Date() });
    expect(second.id).toBe(id);
    expect(second.claimToken).not.toBe(first.claimToken);
    expect(second.attemptCount).toBe(2);
  });

  it('stale lease token cannot overwrite a newer claim (fencing)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const [first] = await claimDueEvents(ctx.db, { limit: 1, leaseMs: 50, now: new Date() });
    await new Promise((r) => setTimeout(r, 80));
    const [second] = await claimDueEvents(ctx.db, { limit: 5, leaseMs: 5000, now: new Date() });

    // Old worker finishes late — must not clobber the new claim.
    const result = await markDelivered(ctx.db, {
      eventId: id,
      leaseToken: first.claimToken,
      attemptId: first.attemptId,
      httpStatus: 201,
      now: new Date(),
    });
    expect(result.fenced).toBe(false);

    const row = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(row?.status).toBe('PROCESSING'); // still owned by `second`
    expect(row?.leaseToken).toBe(second.claimToken);

    const staleAttempt = await ctx.db.notificationAttempt.findUnique({
      where: { id: first.attemptId },
    });
    expect(staleAttempt?.outcome).toBe('STALE_LEASE');

    // New owner can settle normally.
    const ok = await markDelivered(ctx.db, {
      eventId: id,
      leaseToken: second.claimToken,
      attemptId: second.attemptId,
      httpStatus: 201,
      now: new Date(),
    });
    expect(ok.fenced).toBe(true);
    const done = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(done?.status).toBe('DELIVERED');
    expect(done?.deliveredAt).not.toBeNull();
    expect(done?.leaseToken).toBeNull();
  });

  it('stale retry scheduling is ignored as well', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const [first] = await claimDueEvents(ctx.db, { limit: 1, leaseMs: 50, now: new Date() });
    await new Promise((r) => setTimeout(r, 80));
    await claimDueEvents(ctx.db, { limit: 5, leaseMs: 5000, now: new Date() });

    const result = await settleRetry(ctx.db, {
      eventId: id,
      leaseToken: first.claimToken,
      attemptId: first.attemptId,
      outcome: 'RETRY_SCHEDULED',
      nextAttemptAt: new Date(Date.now() + 10_000),
      error: 'stale',
      httpStatus: 503,
      now: new Date(),
    });
    expect(result.fenced).toBe(false);
    const row = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(row?.status).toBe('PROCESSING');
  });
});

describe('worker delivery and retry (scripted sender)', () => {
  let ctx: TestContext;

  beforeAll(() => {
    ctx = createTestContext();
  });

  afterAll(async () => {
    await ctx.handle.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  it('delivers on success and records the attempt', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const sender = scriptedSender(() => ({ kind: 'success', httpStatus: 201 }));
    const { NotificationWorker } = await import('../../src/worker/worker');
    const w = new NotificationWorker({
      db: ctx.db,
      config: ctx.config,
      logger: ctx.logger,
      clock: ctx.clock,
      sender,
    });
    const stats = await w.runOnce();
    expect(stats.delivered).toBe(1);

    const row = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(row?.status).toBe('DELIVERED');
    expect(row?.lastError).toBeNull();
  });

  it('schedules bounded retry on transient failure without dropping the job (OFF-05)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const sender = scriptedSender(() => ({
      kind: 'transient',
      httpStatus: 503,
      error: 'HTTP 503',
      retryAfterMs: null,
    }));
    const { NotificationWorker } = await import('../../src/worker/worker');
    const w = new NotificationWorker({
      db: ctx.db,
      config: ctx.config,
      logger: ctx.logger,
      clock: ctx.clock,
      sender,
    });
    const before = Date.now();
    const stats = await w.runOnce();
    expect(stats.retried).toBe(1);

    const row = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(row?.status).toBe('PENDING');
    expect(row?.attemptCount).toBe(1);
    // Scheduled strictly after the failure was processed (bounded jitter ≥ minMs).
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(before);
    expect(row?.lastError).toContain('503');
    expect(row?.leaseToken).toBeNull();
  });

  it('parks permanent failures as NEEDS_ATTENTION', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const sender = scriptedSender(() => ({
      kind: 'permanent',
      httpStatus: 400,
      error: 'HTTP 400',
    }));
    const { NotificationWorker } = await import('../../src/worker/worker');
    const w = new NotificationWorker({
      db: ctx.db,
      config: ctx.config,
      logger: ctx.logger,
      clock: ctx.clock,
      sender,
    });
    const stats = await w.runOnce();
    expect(stats.needsAttention).toBe(1);

    const row = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(row?.status).toBe('NEEDS_ATTENTION');
    expect(row?.lastError).toContain('400');
  });

  it("one recipient's failure does not block another's delivery (OFF-05)", async () => {
    const failing = await makeMember(ctx, 'failing');
    const healthy = await makeMember(ctx, 'healthy');
    const workshop = await makeWorkshop(ctx);
    const bad = await makeEvent(ctx, { recipientId: failing.id, workshopId: workshop.id });
    const good = await makeEvent(ctx, {
      recipientId: healthy.id,
      workshopId: workshop.id,
      dedupeKey: 'test:good',
    });

    const sender = scriptedSender((body) =>
      body.recipientId === failing.id
        ? { kind: 'transient', httpStatus: 503, error: 'down', retryAfterMs: null }
        : { kind: 'success', httpStatus: 201 },
    );
    const { NotificationWorker } = await import('../../src/worker/worker');
    const w = new NotificationWorker({
      db: ctx.db,
      config: ctx.config,
      logger: ctx.logger,
      clock: ctx.clock,
      sender,
    });
    const stats = await w.runOnce();
    expect(stats.claimed).toBe(2);
    expect(stats.delivered).toBe(1);
    expect(stats.retried).toBe(1);

    const goodRow = await ctx.db.notificationEvent.findUnique({ where: { id: good.id } });
    const badRow = await ctx.db.notificationEvent.findUnique({ where: { id: bad.id } });
    expect(goodRow?.status).toBe('DELIVERED');
    expect(badRow?.status).toBe('PENDING');
  });

  it('retry state survives worker restart (nextAttemptAt is durable) (OFF-04)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const failing = scriptedSender(() => ({
      kind: 'transient',
      httpStatus: 503,
      error: 'down',
      retryAfterMs: null,
    }));
    const { NotificationWorker } = await import('../../src/worker/worker');
    const w1 = new NotificationWorker({
      db: ctx.db,
      config: ctx.config,
      logger: ctx.logger,
      clock: ctx.clock,
      sender: failing,
    });
    await w1.runOnce();
    // "Restart": a brand-new worker with a healthy sender.
    const healthy = scriptedSender(() => ({ kind: 'success', httpStatus: 201 }));
    const w2 = new NotificationWorker({
      db: ctx.db,
      config: ctx.config,
      logger: ctx.logger,
      clock: ctx.clock,
      sender: healthy,
    });
    // Not yet due.
    const idle = await w2.runOnce();
    expect(idle.claimed).toBe(0);

    // Wait for the tiny test backoff to pass, then it delivers.
    await new Promise((r) => setTimeout(r, 150));
    const stats = await w2.runOnce();
    expect(stats.delivered).toBe(1);
    const row = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(row?.status).toBe('DELIVERED');
  });
});

describe('worker against the real mock service', () => {
  let ctx: TestContext;
  let mock: RunningMock;

  beforeAll(async () => {
    ctx = createTestContext();
    mock = await startMock(ctx);
  });

  afterAll(async () => {
    await mock.close();
    await ctx.handle.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
  });

  it('end-to-end: claim → POST /notifications → receipt → DELIVERED', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    const { worker } = makeWorker(ctx, { mockUrl: mock.url });
    const stats = await worker.runOnce();
    expect(stats.delivered).toBe(1);

    const receipts = await ctx.db.mockDeliveryReceipt.findMany();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].idempotencyKey).toBe(id);
  });

  it('resend after lost response is deduplicated by the receiver', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    const { id } = await makeEvent(ctx, { recipientId: member.id, workshopId: workshop.id });

    // Simulate: delivery reached the receiver, but the worker crashed before
    // marking DELIVERED (crash window table in PRD §9). The first send uses the
    // exact stored payload, as the crashed worker would have.
    const { sender } = makeWorker(ctx, { mockUrl: mock.url });
    const { buildDeliveryBody } = await import('../../src/domain/events');
    const stored = await ctx.db.notificationEvent.findUniqueOrThrow({ where: { id } });
    const payload = stored.payload as unknown as {
      payloadVersion: number;
      message: import('../../src/domain/types').ConfirmationMessage;
    };
    const first = await sender.send(buildDeliveryBody(id, 'REGISTRATION_CONFIRMED', member.id, payload), id);
    expect(first.kind).toBe('success');

    // Worker "restarts" and resends the same event id + same snapshot.
    const { worker } = makeWorker(ctx, { mockUrl: mock.url });
    await worker.runOnce();

    const receipts = await ctx.db.mockDeliveryReceipt.findMany({ where: { idempotencyKey: id } });
    expect(receipts).toHaveLength(1); // duplicate suppressed
    const row = await ctx.db.notificationEvent.findUnique({ where: { id } });
    expect(row?.status).toBe('DELIVERED');
  });
});
