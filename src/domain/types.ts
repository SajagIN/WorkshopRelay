/**
 * Domain types shared by API, worker and mock service.
 */

export type WorkshopStatus = 'ACTIVE' | 'CANCELLED';
export type NotificationEventType = 'REGISTRATION_CONFIRMED' | 'WORKSHOP_CANCELLED';
export type NotificationEventStatus = 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'NEEDS_ATTENTION';
export type AttemptOutcome = 'SUCCESS' | 'RETRY_SCHEDULED' | 'NEEDS_ATTENTION' | 'STALE_LEASE';

/** Current payload snapshot version. Bump when message shape changes. */
export const PAYLOAD_VERSION = 1;

export interface ConfirmationMessage {
  workshopId: string;
  title: string;
  scheduledAt: string;
  memberId: string;
  memberName: string;
  notificationAddress: string;
  registeredAt: string;
}

export interface CancellationMessage {
  workshopId: string;
  title: string;
  scheduledAt: string;
  status: 'CANCELLED';
  cancelledAt: string;
  memberId: string;
  notificationAddress: string;
}

export interface EventPayload {
  payloadVersion: number;
  message: ConfirmationMessage | CancellationMessage;
}

/** Request body posted to the mock notification service. */
export interface DeliveryBody {
  eventId: string;
  type: NotificationEventType;
  recipientId: string;
  payloadVersion: number;
  message: ConfirmationMessage | CancellationMessage;
}

/** A claimed outbox row as the worker sees it. */
export interface ClaimedEvent {
  id: string;
  dedupeKey: string;
  type: NotificationEventType;
  recipientId: string;
  workshopId: string;
  registrationId: string | null;
  payload: EventPayload;
  status: NotificationEventStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  leaseToken: string | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  /** Fencing token assigned during the claim that produced this snapshot. */
  claimToken: string;
  /** Attempt row created atomically with the claim. */
  attemptId: string;
}

export interface Identity {
  token: string;
  label: string;
  role: 'ORGANIZER' | 'MEMBER';
  memberId: string | null;
}
