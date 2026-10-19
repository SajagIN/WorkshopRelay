/**
 * Event identity and payload snapshots.
 *
 * - Semantic dedupe keys make event creation idempotent at the database level.
 * - Payloads are immutable snapshots: later DB edits never change queued meaning.
 * - Canonical JSON + hashing give the receiver a stable duplicate check.
 */
import { createHash } from 'node:crypto';
import type {
  CancellationMessage,
  ConfirmationMessage,
  DeliveryBody,
  EventPayload,
  NotificationEventType,
} from './types';
import { PAYLOAD_VERSION } from './types';

export function confirmationDedupeKey(registrationId: string): string {
  return `confirmation:${registrationId}`;
}

export function cancellationDedupeKey(workshopId: string, memberId: string): string {
  return `cancellation:${workshopId}:${memberId}`;
}

export function buildConfirmationPayload(message: ConfirmationMessage): EventPayload {
  return { payloadVersion: PAYLOAD_VERSION, message };
}

export function buildCancellationPayload(message: CancellationMessage): EventPayload {
  return { payloadVersion: PAYLOAD_VERSION, message };
}

export function buildDeliveryBody(
  eventId: string,
  type: NotificationEventType,
  recipientId: string,
  payload: EventPayload,
): DeliveryBody {
  return {
    eventId,
    type,
    recipientId,
    payloadVersion: payload.payloadVersion,
    message: payload.message,
  };
}

/**
 * Deterministic JSON serialization: object keys sorted recursively so the
 * same logical body always hashes identically regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      out[key] = sortValue(src[key]);
    }
    return out;
  }
  return value;
}

export function payloadHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
