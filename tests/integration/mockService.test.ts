/**
 * Integration: mock notification service behavior — receipts, idempotency,
 * fault modes (OFF-07), durability of duplicate suppression.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  startMock,
  truncateAll,
  type RunningMock,
  type TestContext,
} from '../helpers/context';
import { buildDeliveryBody, payloadHash } from '../../src/domain/events';
import type { DeliveryBody } from '../../src/domain/types';

function deliveryFor(eventId: string, recipientId: string): DeliveryBody {
  return buildDeliveryBody(
    eventId,
    'REGISTRATION_CONFIRMED',
    recipientId,
    {
      payloadVersion: 1,
      message: {
        workshopId: 'ws',
        title: 'T',
        scheduledAt: '2026-12-01T10:00:00.000Z',
        memberId: recipientId,
        memberName: 'M',
        notificationAddress: 'm@synthetic.invalid',
        registeredAt: '2026-11-01T00:00:00.000Z',
      },
    },
  );
}

async function post(
  mock: RunningMock,
  body: DeliveryBody,
  opts: { token?: string | null; key?: string | null } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token === undefined ? 'mock-service-token' : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const key = opts.key === undefined ? body.eventId : opts.key;
  if (key) headers['idempotency-key'] = key;

  const response = await fetch(`${mock.url}/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('mock service', () => {
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
    mock.faults.clear();
  });

  it('accepts a delivery and stores an atomic receipt', async () => {
    const body = deliveryFor('evt-1', 'rec-1');
    const result = await post(mock, body);
    expect(result.status).toBe(201);
    expect(result.json.duplicate).toBe(false);

    const receipts = await ctx.db.mockDeliveryReceipt.findMany();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].idempotencyKey).toBe('evt-1');
    expect(receipts[0].payloadHash).toBe(payloadHash(body));
  });

  it('suppresses duplicates with the same key + same payload (no second receipt)', async () => {
    const body = deliveryFor('evt-2', 'rec-1');
    const first = await post(mock, body);
    const second = await post(mock, body);
    const third = await post(mock, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.duplicate).toBe(true);
    expect(third.json.duplicate).toBe(true);
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
  });

  it('rejects the same key with a different payload (409, surfaced for investigation)', async () => {
    await post(mock, deliveryFor('evt-3', 'rec-1'));
    const mismatch = await post(mock, deliveryFor('evt-3', 'rec-2'));
    expect(mismatch.status).toBe(409);
    expect((mismatch.json.error as { code: string }).code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('requires auth and an idempotency key', async () => {
    const body = deliveryFor('evt-4', 'rec-1');
    expect((await post(mock, body, { token: 'wrong' })).status).toBe(401);
    expect((await post(mock, body, { token: null })).status).toBe(401);
    expect((await post(mock, body, { key: null })).status).toBe(400);
  });

  it('fail_first_n: fails N times then recovers', async () => {
    mock.faults.setRule({ mode: 'fail_first_n', scope: { kind: 'global' }, failFirstN: 2 });
    const body = deliveryFor('evt-5', 'rec-1');
    expect((await post(mock, body)).status).toBe(503);
    expect((await post(mock, body)).status).toBe(503);
    expect((await post(mock, body)).status).toBe(201);
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
  });

  it('always_503 scoped to one recipient leaves others healthy', async () => {
    mock.faults.setRule({
      mode: 'always_503',
      scope: { kind: 'recipient', recipientId: 'bad-rec' },
    });
    expect((await post(mock, deliveryFor('evt-6a', 'bad-rec'))).status).toBe(503);
    expect((await post(mock, deliveryFor('evt-6b', 'good-rec'))).status).toBe(201);
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
  });

  it('always_400 produces a permanent failure (400)', async () => {
    mock.faults.setRule({ mode: 'always_400', scope: { kind: 'global' } });
    const result = await post(mock, deliveryFor('evt-7', 'rec-1'));
    expect(result.status).toBe(400);
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(0);
  });

  it('timeout_before_commit: no receipt is written (ambiguous timeout is retryable)', async () => {
    mock.faults.setRule({
      mode: 'timeout_before_commit',
      scope: { kind: 'global' },
      hangMs: 700,
    });
    const body = deliveryFor('evt-8', 'rec-1');
    await expect(
      fetch(`${mock.url}/notifications`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer mock-service-token',
          'idempotency-key': 'evt-8',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();

    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(0);
  });

  it('commit_then_timeout: receipt survives a lost response; resend dedupes', async () => {
    mock.faults.setRule({
      mode: 'commit_then_timeout',
      scope: { kind: 'global' },
      hangMs: 700,
    });
    const body = deliveryFor('evt-9', 'rec-1');
    await expect(
      fetch(`${mock.url}/notifications`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer mock-service-token',
          'idempotency-key': 'evt-9',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();

    // Receipt committed before the hang.
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);

    // Fault cleared; the retry with the same key gets duplicate success.
    mock.faults.clear();
    const retry = await post(mock, body);
    expect(retry.status).toBe(200);
    expect(retry.json.duplicate).toBe(true);
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
  });

  it('seeded_random is reproducible and recorded', async () => {
    mock.faults.setRule({
      mode: 'seeded_random',
      scope: { kind: 'global' },
      seed: 1234,
      failureRate: 0.5,
    });
    const results: number[] = [];
    for (let i = 0; i < 8; i++) {
      results.push((await post(mock, deliveryFor(`evt-r${i}`, 'rec-1'))).status);
    }
    const state = mock.faults.getState();
    expect(state.seed).toBe(1234);
    expect(results).toContain(503);
    expect(results).toContain(201);
  });

  it('reset clears receipts and faults', async () => {
    await post(mock, deliveryFor('evt-10', 'rec-1'));
    mock.faults.setRule({ mode: 'always_503', scope: { kind: 'global' } });

    const response = await fetch(`${mock.url}/admin/reset`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer mock-admin-token',
      },
      body: JSON.stringify({ clearReceipts: true }),
    });
    expect(response.status).toBe(200);
    expect(await ctx.db.mockDeliveryReceipt.count()).toBe(0);
    expect(mock.faults.getState().mode).toBe('always_success');
  });

  it('faults can be disabled via config (403)', async () => {
    const strictCtx = createTestContext({ ENABLE_DEMO_FAULTS: 'false' });
    const strictMock = await startMock(strictCtx);
    try {
      const response = await fetch(`${strictMock.url}/admin/faults`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer mock-admin-token',
        },
        body: JSON.stringify({ mode: 'always_503' }),
      });
      expect(response.status).toBe(403);
    } finally {
      await strictMock.close();
      await strictCtx.handle.close();
    }
  });

  it('admin endpoints require the admin token', async () => {
    const response = await fetch(`${mock.url}/receipts`, {
      headers: { authorization: 'Bearer mock-service-token' },
    });
    expect(response.status).toBe(401);
  });

  it('receipts survive a mock restart (durable duplicate suppression)', async () => {
    const body = deliveryFor('evt-11', 'rec-1');
    await post(mock, body);

    // "Restart": a brand-new mock app on a new port sharing the same database.
    const restarted = await startMock(ctx);
    try {
      const retry = await post(restarted, body);
      expect(retry.status).toBe(200);
      expect(retry.json.duplicate).toBe(true);
      expect(await ctx.db.mockDeliveryReceipt.count()).toBe(1);
    } finally {
      await restarted.close();
    }
  });
});
