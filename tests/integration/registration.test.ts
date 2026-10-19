/**
 * Integration: registration transactions against real PostgreSQL (OFF-01, OFF-03).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  makeMember,
  makeWorkshop,
  truncateAll,
  type TestContext,
} from '../helpers/context';
import { registerForWorkshop, getWorkshopDetail } from '../../src/api/services/workshopService';
import { AppError } from '../../src/shared/errors';

describe('registration transactions', () => {
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

  it('commits registration and confirmation event atomically (OFF-03)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);

    const result = await registerForWorkshop(ctx, workshop.id, member);
    expect(result.registrationId).toBeTruthy();
    expect(result.notification.status).toBe('PENDING');

    const reg = await ctx.db.registration.findUnique({ where: { id: result.registrationId } });
    expect(reg).not.toBeNull();

    const events = await ctx.db.notificationEvent.findMany({
      where: { registrationId: result.registrationId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('REGISTRATION_CONFIRMED');
    expect(events[0].dedupeKey).toBe(`confirmation:${result.registrationId}`);
    expect(events[0].status).toBe('PENDING');

    // Payload is a versioned snapshot.
    const payload = events[0].payload as { payloadVersion: number; message: { title: string } };
    expect(payload.payloadVersion).toBe(1);
    expect(payload.message.title).toBe('Test Workshop');
  });

  it('rejects duplicate registration with 409 and creates no second event (OFF-01)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);

    await registerForWorkshop(ctx, workshop.id, member);
    await expect(registerForWorkshop(ctx, workshop.id, member)).rejects.toMatchObject({
      code: 'ALREADY_REGISTERED',
      status: 409,
    });

    expect(await ctx.db.registration.count({ where: { workshopId: workshop.id } })).toBe(1);
    expect(await ctx.db.notificationEvent.count({ where: { workshopId: workshop.id } })).toBe(1);
  });

  it('rolls back both records when the transaction fails (failed registration → no confirmation)', async () => {
    const workshop = await makeWorkshop(ctx);
    // Member row does not exist → FK violation inside the transaction.
    const ghost = {
      id: 'member-does-not-exist',
      displayName: 'Ghost',
      notificationAddress: 'ghost@synthetic.invalid',
    };
    await expect(registerForWorkshop(ctx, workshop.id, ghost)).rejects.toThrow();

    expect(await ctx.db.registration.count({ where: { workshopId: workshop.id } })).toBe(0);
    expect(await ctx.db.notificationEvent.count({ where: { workshopId: workshop.id } })).toBe(0);
  });

  it('rejects registration for a missing workshop (404)', async () => {
    const member = await makeMember(ctx, 'alice');
    await expect(registerForWorkshop(ctx, 'nope', member)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });

  it('rejects registration for a cancelled workshop (409)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);
    await ctx.db.workshop.update({
      where: { id: workshop.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    await expect(registerForWorkshop(ctx, workshop.id, member)).rejects.toMatchObject({
      code: 'WORKSHOP_CANCELLED',
      status: 409,
    });
  });

  it('handles concurrent duplicate registrations: exactly one wins (OFF-01)', async () => {
    const member = await makeMember(ctx, 'alice');
    const workshop = await makeWorkshop(ctx);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => registerForWorkshop(ctx, workshop.id, member)),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect(((r as PromiseRejectedResult).reason as AppError).code).toBe('ALREADY_REGISTERED');
    }

    expect(await ctx.db.registration.count({ where: { workshopId: workshop.id } })).toBe(1);
    expect(await ctx.db.notificationEvent.count({ where: { workshopId: workshop.id } })).toBe(1);
  });

  it('records viewer registration state in workshop detail', async () => {
    const member = await makeMember(ctx, 'alice');
    const other = await makeMember(ctx, 'bob');
    const workshop = await makeWorkshop(ctx);

    let detail = await getWorkshopDetail(ctx, workshop.id, member.id);
    expect(detail?.viewerRegistered).toBe(false);

    await registerForWorkshop(ctx, workshop.id, member);
    detail = await getWorkshopDetail(ctx, workshop.id, member.id);
    expect(detail?.viewerRegistered).toBe(true);

    detail = await getWorkshopDetail(ctx, workshop.id, other.id);
    expect(detail?.viewerRegistered).toBe(false);
  });
});
