import { describe, expect, it } from 'vitest';
import {
  buildCancellationPayload,
  buildConfirmationPayload,
  buildDeliveryBody,
  cancellationDedupeKey,
  canonicalJson,
  confirmationDedupeKey,
  payloadHash,
} from '../../src/domain/events';
import { PAYLOAD_VERSION } from '../../src/domain/types';

describe('semantic dedupe keys', () => {
  it('builds confirmation keys from the registration id (OFF-03)', () => {
    expect(confirmationDedupeKey('reg-1')).toBe('confirmation:reg-1');
  });

  it('builds cancellation keys per workshop+member (OFF-06)', () => {
    expect(cancellationDedupeKey('ws-1', 'm-1')).toBe('cancellation:ws-1:m-1');
  });

  it('produces distinct keys for distinct logical events', () => {
    expect(confirmationDedupeKey('r1')).not.toBe(confirmationDedupeKey('r2'));
    expect(cancellationDedupeKey('w', 'm1')).not.toBe(cancellationDedupeKey('w', 'm2'));
  });
});

describe('payload snapshots', () => {
  it('versions confirmation payloads', () => {
    const payload = buildConfirmationPayload({
      workshopId: 'w',
      title: 'T',
      scheduledAt: '2026-12-01T10:00:00.000Z',
      memberId: 'm',
      memberName: 'M',
      notificationAddress: 'm@x.invalid',
      registeredAt: '2026-11-01T00:00:00.000Z',
    });
    expect(payload.payloadVersion).toBe(PAYLOAD_VERSION);
    expect(payload.message).toHaveProperty('registeredAt');
  });

  it('versions cancellation payloads and states final status', () => {
    const payload = buildCancellationPayload({
      workshopId: 'w',
      title: 'T',
      scheduledAt: '2026-12-01T10:00:00.000Z',
      status: 'CANCELLED',
      cancelledAt: '2026-11-02T00:00:00.000Z',
      memberId: 'm',
      notificationAddress: 'm@x.invalid',
    });
    expect(payload.payloadVersion).toBe(PAYLOAD_VERSION);
    expect(payload.message).toMatchObject({ status: 'CANCELLED' });
  });

  it('wraps payload into the delivery body with eventId/type/recipient', () => {
    const payload = buildConfirmationPayload({
      workshopId: 'w',
      title: 'T',
      scheduledAt: '2026-12-01T10:00:00.000Z',
      memberId: 'm',
      memberName: 'M',
      notificationAddress: 'm@x.invalid',
      registeredAt: '2026-11-01T00:00:00.000Z',
    });
    const body = buildDeliveryBody('evt-1', 'REGISTRATION_CONFIRMED', 'm', payload);
    expect(body.eventId).toBe('evt-1');
    expect(body.type).toBe('REGISTRATION_CONFIRMED');
    expect(body.recipientId).toBe('m');
    expect(body.payloadVersion).toBe(PAYLOAD_VERSION);
    expect(body.message).toBe(payload.message);
  });
});

describe('canonical JSON + payload hashing', () => {
  it('is stable regardless of key order', () => {
    const a = { b: 1, a: { z: 3, y: [1, { q: 1, p: 2 }] } };
    const b = { a: { y: [1, { p: 2, q: 1 }], z: 3 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  it('changes when any value changes', () => {
    const a = { x: 'one' };
    const b = { x: 'two' };
    expect(payloadHash(a)).not.toBe(payloadHash(b));
  });

  it('hashes to a 64-char hex digest', () => {
    expect(payloadHash({ hello: 'world' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
