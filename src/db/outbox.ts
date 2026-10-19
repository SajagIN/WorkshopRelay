/**
 * Outbox claim and settle operations (PRD §9 "Worker claim").
 *
 * Claiming uses SELECT ... FOR UPDATE SKIP LOCKED + lease tokens:
 * - due PENDING jobs are claimed in bounded batches
 * - PROCESSING jobs with expired leases are reclaimed (crash recovery)
 * - every claim creates its attempt row atomically
 * - completion/retry updates are fenced by lease token; stale workers can
 *   never overwrite a newer worker's result
 */
import { randomUUID } from 'node:crypto';
import type { Db } from './client';
import type { ClaimedEvent, EventPayload, NotificationEventStatus, NotificationEventType } from '../domain/types';
import type { AttemptOutcome } from '../domain/types';

export interface ClaimOptions {
  limit: number;
  leaseMs: number;
  now: Date;
}

interface ClaimRow {
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
}

export async function claimDueEvents(db: Db, opts: ClaimOptions): Promise<ClaimedEvent[]> {
  const { limit, leaseMs, now } = opts;
  const leaseUntil = new Date(now.getTime() + leaseMs);

  return db.$transaction(async (tx) => {
    // Lock a bounded batch of due events; concurrent workers skip locked rows.
    const due = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "NotificationEvent"
      WHERE ("status" = 'PENDING'::"NotificationEventStatus" AND "nextAttemptAt" <= ${now})
         OR ("status" = 'PROCESSING'::"NotificationEventStatus"
             AND "leaseUntil" IS NOT NULL AND "leaseUntil" < ${now})
      ORDER BY "nextAttemptAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (due.length === 0) return [];

    const ids = due.map((r) => r.id);

    // Fresh lease token per event (fencing), attemptCount incremented.
    const claimed = await tx.$queryRaw<ClaimRow[]>`
      UPDATE "NotificationEvent"
      SET "status" = 'PROCESSING'::"NotificationEventStatus",
          "leaseToken" = gen_random_uuid()::text,
          "leaseUntil" = ${leaseUntil},
          "attemptCount" = "attemptCount" + 1
      WHERE "id" = ANY(${ids}::text[])
      RETURNING "id", "dedupeKey", "type", "recipientId", "workshopId", "registrationId",
                "payload", "status", "attemptCount", "nextAttemptAt", "leaseUntil",
                "leaseToken", "lastError", "createdAt", "deliveredAt"
    `;

    // Attempt rows are created atomically with the claim.
    const attemptIds = new Map<string, string>();
    for (const row of claimed) {
      const attemptId = randomUUID();
      attemptIds.set(row.id, attemptId);
      await tx.$executeRaw`
        INSERT INTO "NotificationAttempt" ("id", "eventId", "attemptNumber", "startedAt")
        VALUES (${attemptId}, ${row.id}, ${row.attemptCount}, ${now})
      `;
    }

    return claimed.map((row) => ({
      ...row,
      claimToken: row.leaseToken as string,
      attemptId: attemptIds.get(row.id) as string,
    }));
  });
}

export interface SettleResult {
  /** false when the lease token no longer matches (a newer worker owns the job). */
  fenced: boolean;
}

export async function markDelivered(
  db: Db,
  opts: {
    eventId: string;
    leaseToken: string;
    attemptId: string;
    httpStatus: number | null;
    now: Date;
  },
): Promise<SettleResult> {
  return db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "NotificationEvent"
      SET "status" = 'DELIVERED'::"NotificationEventStatus",
          "deliveredAt" = ${opts.now},
          "leaseToken" = NULL,
          "leaseUntil" = NULL,
          "lastError" = NULL
      WHERE "id" = ${opts.eventId}
        AND "leaseToken" = ${opts.leaseToken}
        AND "status" = 'PROCESSING'::"NotificationEventStatus"
    `;
    if (updated === 1) {
      await tx.$executeRaw`
        UPDATE "NotificationAttempt"
        SET "finishedAt" = ${opts.now},
            "outcome" = 'SUCCESS'::"AttemptOutcome",
            "httpStatus" = ${opts.httpStatus}
        WHERE "id" = ${opts.attemptId}
      `;
      return { fenced: true };
    }
    // Stale worker: record the attempt outcome, leave the event alone.
    await tx.$executeRaw`
      UPDATE "NotificationAttempt"
      SET "finishedAt" = ${opts.now},
          "outcome" = 'STALE_LEASE'::"AttemptOutcome",
          "httpStatus" = ${opts.httpStatus},
          "error" = 'lease lost before completion; result ignored'
      WHERE "id" = ${opts.attemptId}
    `;
    return { fenced: false };
  });
}

export async function settleRetry(
  db: Db,
  opts: {
    eventId: string;
    leaseToken: string;
    attemptId: string;
    /** RETRY_SCHEDULED keeps the job retrying; NEEDS_ATTENTION parks it. */
    outcome: Extract<AttemptOutcome, 'RETRY_SCHEDULED' | 'NEEDS_ATTENTION'>;
    nextAttemptAt: Date;
    error: string;
    httpStatus: number | null;
    now: Date;
  },
): Promise<SettleResult> {
  const status = opts.outcome === 'NEEDS_ATTENTION' ? 'NEEDS_ATTENTION' : 'PENDING';
  return db.$transaction(async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "NotificationEvent"
      SET "status" = ${status}::"NotificationEventStatus",
          "nextAttemptAt" = ${opts.nextAttemptAt},
          "leaseToken" = NULL,
          "leaseUntil" = NULL,
          "lastError" = ${opts.error}
      WHERE "id" = ${opts.eventId}
        AND "leaseToken" = ${opts.leaseToken}
        AND "status" = 'PROCESSING'::"NotificationEventStatus"
    `;
    if (updated === 1) {
      await tx.$executeRaw`
        UPDATE "NotificationAttempt"
        SET "finishedAt" = ${opts.now},
            "outcome" = ${opts.outcome}::"AttemptOutcome",
            "httpStatus" = ${opts.httpStatus},
            "error" = ${opts.error}
        WHERE "id" = ${opts.attemptId}
      `;
      return { fenced: true };
    }
    await tx.$executeRaw`
      UPDATE "NotificationAttempt"
      SET "finishedAt" = ${opts.now},
          "outcome" = 'STALE_LEASE'::"AttemptOutcome",
          "httpStatus" = ${opts.httpStatus},
          "error" = 'lease lost before settle; retry scheduling ignored'
      WHERE "id" = ${opts.attemptId}
    `;
    return { fenced: false };
  });
}

export async function upsertWorkerHeartbeat(
  db: Db,
  opts: { workerId: string; pid: number; now: Date },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "WorkerHeartbeat" ("workerId", "pid", "startedAt", "lastSeenAt")
    VALUES (${opts.workerId}, ${opts.pid}, ${opts.now}, ${opts.now})
    ON CONFLICT ("workerId") DO UPDATE
    SET "lastSeenAt" = ${opts.now}, "pid" = ${opts.pid}
  `;
}
