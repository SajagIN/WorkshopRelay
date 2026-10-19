/**
 * Integration: cancellation fan-out and races against real PostgreSQL (OFF-06).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  makeMember,
  makeWorkshop,
  truncateAll,
  type TestContext,
} from '../helpers/context';
import { cancelWorkshop, registerForWorkshop } from '../../src/api/services/workshopService';

describe('cancellation transactions', () => {
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

  it('creates one cancellation event per registered member (OFF-06)', async () => {
    const workshop = await makeWorkshop(ctx);
    const alice = await makeMember(ctx, 'alice');
    const bob = await makeMember(ctx, 'bob');
    const carol = await makeMember(ctx, 'carol');
    await registerForWorkshop(ctx, workshop.id, alice);
    await registerForWorkshop(ctx, workshop.id, bob);
    await registerForWorkshop(ctx, workshop.id, carol);

    const result = await cancelWorkshop(ctx, workshop.id);
    expect(result.alreadyCancelled).toBe(false);
    expect(result.notificationsCreated).toBe(3);

    const cancellations = await ctx.db.notificationEvent.findMany({
      where: { workshopId: workshop.id, type: 'WORKSHOP_CANCELLED' },
    });
    expect(cancellations).toHaveLength(3);
    for (const event of cancellations) {
      expect(event.dedupeKey).toBe(`cancellation:${workshop.id}:${event.recipientId}`);
      expect(event.status).toBe('PENDING');
    }

    // Confirmations already created are NOT deleted (OFF-03 still holds).
    const confirmations = await ctx.db.notificationEvent.count({
      where: { workshopId: workshop.id, type: 'REGISTRATION_CONFIRMED' },
    });
    expect(confirmations).toBe(3);

    // Workshop state.
    const ws = await ctx.db.workshop.findUnique({ where: { id: workshop.id } });
    expect(ws?.status).toBe('CANCELLED');
    expect(ws?.cancelledAt).not.toBeNull();
  });

  it('repeat cancellation is idempotent — no duplicate events (INV-7)', async () => {
    const workshop = await makeWorkshop(ctx);
    const alice = await makeMember(ctx, 'alice');
    await registerForWorkshop(ctx, workshop.id, alice);

    await cancelWorkshop(ctx, workshop.id);
    const second = await cancelWorkshop(ctx, workshop.id);
    const third = await cancelWorkshop(ctx, workshop.id);

    expect(second.alreadyCancelled).toBe(true);
    expect(second.notificationsCreated).toBe(0);
    expect(third.notificationsCreated).toBe(0);

    const total = await ctx.db.notificationEvent.count({ where: { workshopId: workshop.id } });
    expect(total).toBe(2); // 1 confirmation + 1 cancellation
  });

  it('registration after cancellation is rejected', async () => {
    const workshop = await makeWorkshop(ctx);
    const alice = await makeMember(ctx, 'alice');
    await cancelWorkshop(ctx, workshop.id);

    await expect(registerForWorkshop(ctx, workshop.id, alice)).rejects.toMatchObject({
      code: 'WORKSHOP_CANCELLED',
    });
  });

  it('concurrent double-cancel creates exactly one fan-out set', async () => {
    const workshop = await makeWorkshop(ctx);
    for (const label of ['a', 'b', 'c']) {
      await registerForWorkshop(ctx, workshop.id, await makeMember(ctx, label));
    }

    const results = await Promise.allSettled([
      cancelWorkshop(ctx, workshop.id),
      cancelWorkshop(ctx, workshop.id),
      cancelWorkshop(ctx, workshop.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(3);

    const created = fulfilled.map(
      (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof cancelWorkshop>>>).value.notificationsCreated,
    );
    // Exactly one caller created events; the others observed already-cancelled.
    expect(created.reduce((a, b) => a + b, 0)).toBe(3);

    const cancellations = await ctx.db.notificationEvent.count({
      where: { workshopId: workshop.id, type: 'WORKSHOP_CANCELLED' },
    });
    expect(cancellations).toBe(3);
  });

  it('registration/cancellation race respects lock-defined ordering (OFF-06)', async () => {
    const workshop = await makeWorkshop(ctx);
    const late = await makeMember(ctx, 'late');
    const early = await makeMember(ctx, 'early');
    await registerForWorkshop(ctx, workshop.id, early);

    const [regResult, cancelResult] = await Promise.allSettled([
      registerForWorkshop(ctx, workshop.id, late),
      cancelWorkshop(ctx, workshop.id),
    ]);

    expect(cancelResult.status).toBe('fulfilled');

    const regs = await ctx.db.registration.findMany({ where: { workshopId: workshop.id } });
    const cancellations = await ctx.db.notificationEvent.findMany({
      where: { workshopId: workshop.id, type: 'WORKSHOP_CANCELLED' },
    });

    if (regResult.status === 'fulfilled') {
      // Registration committed before cancellation → must be in the fan-out.
      expect(cancellations).toHaveLength(2);
      const recipients = cancellations.map((c) => c.recipientId).sort();
      expect(recipients).toContain(late.id);
      expect(regs).toHaveLength(2);
    } else {
      // Cancellation won the lock → registration rejected, fan-out covers only early.
      expect((regResult.reason as { code?: string }).code).toBe('WORKSHOP_CANCELLED');
      expect(cancellations).toHaveLength(1);
      expect(cancellations[0].recipientId).toBe(early.id);
      expect(regs).toHaveLength(1);
    }
  });

  it('payload snapshots keep the scheduled time and final status', async () => {
    const workshop = await makeWorkshop(ctx);
    const alice = await makeMember(ctx, 'alice');
    await registerForWorkshop(ctx, workshop.id, alice);
    await cancelWorkshop(ctx, workshop.id);

    const event = await ctx.db.notificationEvent.findFirst({
      where: { workshopId: workshop.id, type: 'WORKSHOP_CANCELLED' },
    });
    const payload = event?.payload as {
      payloadVersion: number;
      message: { status: string; cancelledAt: string; notificationAddress: string };
    };
    expect(payload.payloadVersion).toBe(1);
    expect(payload.message.status).toBe('CANCELLED');
    expect(payload.message.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(payload.message.notificationAddress).toBe('alice@synthetic.invalid');
  });
});
