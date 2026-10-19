/**
 * Workshop business transactions (PRD §5 invariants, §9 transaction design).
 *
 * Registration and cancellation both acquire a row lock on the workshop
 * inside one database transaction, and outbox events are created in that
 * same transaction — the API never contacts the notification service.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../app';
import { Prisma } from '../../generated/prisma/client';
import { appErrors } from '../../shared/errors';
import {
  buildConfirmationPayload,
  confirmationDedupeKey,
  cancellationDedupeKey,
} from '../../domain/events';
import type {
  ConfirmationMessage,
  EventPayload,
  NotificationEventStatus,
  NotificationEventType,
  WorkshopStatus,
} from '../../domain/types';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface WorkshopRow {
  id: string;
  title: string;
  description: string | null;
  scheduledAt: Date;
  status: WorkshopStatus;
  createdBy: string;
  createdAt: Date;
  cancelledAt: Date | null;
}

export interface WorkshopListItem extends WorkshopRow {
  registrationCount: number;
}

export interface WorkshopDetail extends WorkshopRow {
  registrationCount: number;
  viewerRegistered: boolean;
  viewerRegistrationId: string | null;
}

export interface RegistrationResult {
  registrationId: string;
  workshopId: string;
  memberId: string;
  notification: { eventId: string; status: NotificationEventStatus };
}

export interface CancellationResult {
  workshop: WorkshopRow;
  alreadyCancelled: boolean;
  notificationsCreated: number;
  eventIds: string[];
}

export interface RosterEntry {
  registrationId: string;
  memberId: string;
  displayName: string;
  notificationAddress: string;
  registeredAt: Date;
}

export interface NotificationStatusSummary {
  workshopId: string;
  counts: Array<{ type: NotificationEventType; status: NotificationEventStatus; count: number }>;
  events: Array<{
    id: string;
    type: NotificationEventType;
    status: NotificationEventStatus;
    recipientId: string;
    attemptCount: number;
    nextAttemptAt: Date;
    lastError: string | null;
    createdAt: Date;
    deliveredAt: Date | null;
  }>;
}

// ---------------------------------------------------------------------------
// Create / list / detail
// ---------------------------------------------------------------------------

export async function createWorkshop(
  ctx: AppContext,
  input: { title: string; description: string | null; scheduledAt: Date },
  createdBy: string,
): Promise<WorkshopRow> {
  const id = randomUUID();
  const now = ctx.clock.now();
  return ctx.db.workshop.create({
    data: {
      id,
      title: input.title.trim(),
      description: input.description,
      scheduledAt: input.scheduledAt,
      status: 'ACTIVE',
      createdBy,
      createdAt: now,
    },
  });
}

export async function listWorkshops(
  ctx: AppContext,
  opts: { status?: WorkshopStatus; limit: number; offset: number; memberId?: string | null },
): Promise<{ items: WorkshopListItem[]; total: number }> {
  const { db } = ctx;
  const where = opts.status
    ? Prisma.sql`w."status" = ${opts.status}::"WorkshopStatus"`
    : Prisma.sql`TRUE`;

  const rows = await db.$queryRaw<WorkshopListItem[]>`
    SELECT w."id", w."title", w."description", w."scheduledAt", w."status",
           w."createdBy", w."createdAt", w."cancelledAt",
           COUNT(r."id")::int AS "registrationCount"
    FROM "Workshop" w
    LEFT JOIN "Registration" r ON r."workshopId" = w."id"
    WHERE ${where}
    GROUP BY w."id"
    ORDER BY w."scheduledAt" DESC, w."createdAt" DESC
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `;
  const items = rows.map((row) => ({
    ...row,
    registrationCount: Number(row.registrationCount),
  }));

  const totalRows = await db.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM "Workshop" w WHERE ${where}
  `;
  return { items, total: Number(totalRows[0]?.count ?? 0) };
}

/**
 * Fetch one workshop plus the viewer's registration state (if memberId given).
 */
export async function getWorkshopDetail(
  ctx: AppContext,
  workshopId: string,
  memberId: string | null,
): Promise<WorkshopDetail | null> {
  const rows = await ctx.db.$queryRaw<
    Array<WorkshopRow & { registrationCount: number; viewerRegistrationId: string | null }>
  >`
    SELECT w."id", w."title", w."description", w."scheduledAt", w."status",
           w."createdBy", w."createdAt", w."cancelledAt",
           (SELECT COUNT(*)::int FROM "Registration" r WHERE r."workshopId" = w."id") AS "registrationCount",
           (SELECT r2."id" FROM "Registration" r2
             WHERE r2."workshopId" = w."id" AND r2."memberId" = ${memberId}) AS "viewerRegistrationId"
    FROM "Workshop" w
    WHERE w."id" = ${workshopId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    scheduledAt: row.scheduledAt,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    cancelledAt: row.cancelledAt,
    registrationCount: Number(row.registrationCount),
    viewerRegistered: row.viewerRegistrationId != null,
    viewerRegistrationId: row.viewerRegistrationId,
  };
}

// ---------------------------------------------------------------------------
// Registration (PRD §9)
// ---------------------------------------------------------------------------

interface MemberSnapshot {
  id: string;
  displayName: string;
  notificationAddress: string;
}

export async function registerForWorkshop(
  ctx: AppContext,
  workshopId: string,
  member: MemberSnapshot,
): Promise<RegistrationResult> {
  const { db, clock } = ctx;
  const now = clock.now();

  return db.$transaction(async (tx) => {
    // 1. Lock the workshop row: serializes registration vs. cancellation.
    const locked = await tx.$queryRaw<
      Array<{ id: string; title: string; scheduledAt: Date; status: WorkshopStatus }>
    >`
      SELECT "id", "title", "scheduledAt", "status"
      FROM "Workshop"
      WHERE "id" = ${workshopId}
      FOR UPDATE
    `;
    const workshop = locked[0];
    if (!workshop) {
      throw appErrors.notFound('Workshop not found.');
    }
    if (workshop.status === 'CANCELLED') {
      throw appErrors.workshopCancelled();
    }

    // 2. Insert the registration, protected by the (workshopId, memberId) unique
    //    constraint. ON CONFLICT DO NOTHING turns races into clean 409s.
    const registrationId = randomUUID();
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "Registration" ("id", "workshopId", "memberId", "createdAt")
      VALUES (${registrationId}, ${workshopId}, ${member.id}, ${now})
      ON CONFLICT ("workshopId", "memberId") DO NOTHING
      RETURNING "id"
    `;
    if (inserted.length === 0) {
      throw appErrors.alreadyRegistered();
    }

    // 3. Confirmation event in the SAME transaction (durable obligation).
    const message: ConfirmationMessage = {
      workshopId,
      title: workshop.title,
      scheduledAt: workshop.scheduledAt.toISOString(),
      memberId: member.id,
      memberName: member.displayName,
      notificationAddress: member.notificationAddress,
      registeredAt: now.toISOString(),
    };
    const payload: EventPayload = buildConfirmationPayload(message);
    const eventId = randomUUID();

    await tx.$executeRaw`
      INSERT INTO "NotificationEvent" (
        "id", "dedupeKey", "type", "recipientId", "workshopId", "registrationId",
        "payload", "status", "attemptCount", "nextAttemptAt", "createdAt"
      ) VALUES (
        ${eventId},
        ${confirmationDedupeKey(registrationId)},
        'REGISTRATION_CONFIRMED'::"NotificationEventType",
        ${member.id},
        ${workshopId},
        ${registrationId},
        ${JSON.stringify(payload)}::jsonb,
        'PENDING'::"NotificationEventStatus",
        0,
        ${now},
        ${now}
      )
    `;

    return {
      registrationId,
      workshopId,
      memberId: member.id,
      notification: { eventId, status: 'PENDING' as const },
    };
  });
}

// ---------------------------------------------------------------------------
// Cancellation (PRD §9)
// ---------------------------------------------------------------------------

export async function cancelWorkshop(ctx: AppContext, workshopId: string): Promise<CancellationResult> {
  const { db, clock } = ctx;
  const now = clock.now();

  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<WorkshopRow[]>`
      SELECT "id", "title", "description", "scheduledAt", "status",
             "createdBy", "createdAt", "cancelledAt"
      FROM "Workshop"
      WHERE "id" = ${workshopId}
      FOR UPDATE
    `;
    const workshop = locked[0];
    if (!workshop) {
      throw appErrors.notFound('Workshop not found.');
    }

    // Repeat cancellation is idempotent: no new events, current state returned.
    if (workshop.status === 'CANCELLED') {
      return {
        workshop,
        alreadyCancelled: true,
        notificationsCreated: 0,
        eventIds: [] as string[],
      };
    }

    await tx.$executeRaw`
      UPDATE "Workshop"
      SET "status" = 'CANCELLED'::"WorkshopStatus", "cancelledAt" = ${now}
      WHERE "id" = ${workshopId}
    `;

    // Fan-out in one INSERT ... SELECT, dedupe-key protected. The key format
    // is exactly `cancellationDedupeKey(workshopId, memberId)` per registrant.
    const dedupePrefix = cancellationDedupeKey(workshopId, '');
    const cancelledAtIso = now.toISOString();
    const created = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "NotificationEvent" (
        "id", "dedupeKey", "type", "recipientId", "workshopId", "registrationId",
        "payload", "status", "attemptCount", "nextAttemptAt", "createdAt"
      )
      SELECT
        gen_random_uuid(),
        ${dedupePrefix}::text || r."memberId",
        'WORKSHOP_CANCELLED'::"NotificationEventType",
        r."memberId",
        r."workshopId",
        r."id",
        jsonb_build_object(
          'payloadVersion', 1,
          'message', jsonb_build_object(
            'workshopId', r."workshopId",
            'title', w."title",
            'scheduledAt', to_char(w."scheduledAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'status', 'CANCELLED',
            'cancelledAt', ${cancelledAtIso}::text,
            'memberId', r."memberId",
            'notificationAddress', m."notificationAddress"
          )
        ),
        'PENDING'::"NotificationEventStatus",
        0,
        ${now}::timestamptz,
        ${now}::timestamptz
      FROM "Registration" r
      JOIN "Workshop" w ON w."id" = r."workshopId"
      JOIN "Member" m ON m."id" = r."memberId"
      WHERE r."workshopId" = ${workshopId}::text
      ON CONFLICT ("dedupeKey") DO NOTHING
      RETURNING "id"
    `;

    return {
      workshop: {
        ...workshop,
        status: 'CANCELLED' as const,
        cancelledAt: now,
      },
      alreadyCancelled: false,
      notificationsCreated: created.length,
      eventIds: created.map((r) => r.id),
    };
  });
}

// ---------------------------------------------------------------------------
// Roster + notification status
// ---------------------------------------------------------------------------

export async function listRegistrations(
  ctx: AppContext,
  workshopId: string,
  opts: { limit: number; offset: number },
): Promise<{ items: RosterEntry[]; total: number }> {
  const { db } = ctx;

  const exists = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Workshop" WHERE "id" = ${workshopId}
  `;
  if (exists.length === 0) throw appErrors.notFound('Workshop not found.');

  const items = await db.$queryRaw<RosterEntry[]>`
    SELECT r."id" AS "registrationId", r."memberId", m."displayName",
           m."notificationAddress", r."createdAt" AS "registeredAt"
    FROM "Registration" r
    JOIN "Member" m ON m."id" = r."memberId"
    WHERE r."workshopId" = ${workshopId}
    ORDER BY r."createdAt" ASC
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `;
  const totalRows = await db.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM "Registration" WHERE "workshopId" = ${workshopId}
  `;
  return { items, total: Number(totalRows[0]?.count ?? 0) };
}

export async function notificationStatusForWorkshop(
  ctx: AppContext,
  workshopId: string,
): Promise<NotificationStatusSummary> {
  const { db } = ctx;

  const exists = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Workshop" WHERE "id" = ${workshopId}
  `;
  if (exists.length === 0) throw appErrors.notFound('Workshop not found.');

  const counts = await ctx.db.$queryRaw<
    Array<{ type: NotificationEventType; status: NotificationEventStatus; count: number }>
  >`
    SELECT "type", "status", COUNT(*)::int AS "count"
    FROM "NotificationEvent"
    WHERE "workshopId" = ${workshopId}
    GROUP BY "type", "status"
    ORDER BY "type", "status"
  `;

  const events = await ctx.db.$queryRaw<NotificationStatusSummary['events']>`
    SELECT "id", "type", "status", "recipientId", "attemptCount",
           "nextAttemptAt", "lastError", "createdAt", "deliveredAt"
    FROM "NotificationEvent"
    WHERE "workshopId" = ${workshopId}
    ORDER BY "createdAt" DESC
    LIMIT 100
  `;

  return {
    workshopId,
    counts: counts.map((c) => ({ ...c, count: Number(c.count) })),
    events,
  };
}
