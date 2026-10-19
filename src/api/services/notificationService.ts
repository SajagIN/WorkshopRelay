/**
 * Notification event inspection and manual requeue (organizer tools).
 */
import type { AppContext } from '../app';
import { Prisma } from '../../generated/prisma/client';
import { appErrors } from '../../shared/errors';
import type {
  AttemptOutcome,
  NotificationEventStatus,
  NotificationEventType,
} from '../../domain/types';

export interface AttemptView {
  id: string;
  attemptNumber: number;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: AttemptOutcome | null;
  httpStatus: number | null;
  error: string | null;
}

export interface EventDetail {
  id: string;
  dedupeKey: string;
  type: NotificationEventType;
  recipientId: string;
  workshopId: string;
  registrationId: string | null;
  status: NotificationEventStatus;
  attemptCount: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
  payload: unknown;
  attempts: AttemptView[];
}

export interface EventListItem {
  id: string;
  type: NotificationEventType;
  status: NotificationEventStatus;
  recipientId: string;
  recipientName: string;
  workshopId: string;
  workshopTitle: string;
  attemptCount: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface EventListResult {
  items: EventListItem[];
  total: number;
  statusCounts: Array<{ status: NotificationEventStatus; count: number }>;
}

/**
 * Dashboard-oriented event list (extension beyond the PRD's core contract:
 * the PRD exposes per-workshop status + single-event detail; the console
 * benefits from a filterable cross-workshop view).
 */
export async function listEvents(
  ctx: AppContext,
  opts: {
    status?: NotificationEventStatus;
    type?: NotificationEventType;
    workshopId?: string;
    search?: string;
    limit: number;
    offset: number;
  },
): Promise<EventListResult> {
  const clauses: ReturnType<typeof Prisma.sql>[] = [];
  if (opts.status) clauses.push(Prisma.sql`e."status" = ${opts.status}::"NotificationEventStatus"`);
  if (opts.type) clauses.push(Prisma.sql`e."type" = ${opts.type}::"NotificationEventType"`);
  if (opts.workshopId) clauses.push(Prisma.sql`e."workshopId" = ${opts.workshopId}`);
  if (opts.search) {
    const q = `%${opts.search}%`;
    clauses.push(
      Prisma.sql`(e."id"::text ILIKE ${q} OR e."recipientId" ILIKE ${q} OR m."displayName" ILIKE ${q} OR w."title" ILIKE ${q})`,
    );
  }
  const where = clauses.length > 0 ? Prisma.join(clauses, ' AND ') : Prisma.sql`TRUE`;

  const rows = await ctx.db.$queryRaw<EventListItem[]>`
    SELECT e."id", e."type", e."status", e."recipientId",
           m."displayName" AS "recipientName",
           e."workshopId", w."title" AS "workshopTitle",
           e."attemptCount", e."nextAttemptAt", e."lastError",
           e."createdAt", e."deliveredAt"
    FROM "NotificationEvent" e
    JOIN "Member" m ON m."id" = e."recipientId"
    JOIN "Workshop" w ON w."id" = e."workshopId"
    WHERE ${where}
    ORDER BY e."createdAt" DESC
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `;
  const totalRows = await ctx.db.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM "NotificationEvent" e
    JOIN "Member" m ON m."id" = e."recipientId"
    JOIN "Workshop" w ON w."id" = e."workshopId"
    WHERE ${where}
  `;
  const statusCounts = await ctx.db.$queryRaw<
    Array<{ status: NotificationEventStatus; count: number }>
  >`
    SELECT "status", COUNT(*)::int AS "count" FROM "NotificationEvent" GROUP BY "status"
  `;

  return {
    items: rows.map((r) => ({ ...r, attemptCount: Number(r.attemptCount) })),
    total: Number(totalRows[0]?.count ?? 0),
    statusCounts: statusCounts.map((c) => ({ ...c, count: Number(c.count) })),
  };
}

export async function getEventDetail(ctx: AppContext, eventId: string): Promise<EventDetail | null> {
  const rows = await ctx.db.$queryRaw<
    Array<Omit<EventDetail, 'attempts'> & { payload: unknown }>
  >`
    SELECT "id", "dedupeKey", "type", "recipientId", "workshopId", "registrationId",
           "status", "attemptCount", "nextAttemptAt", "leaseUntil", "lastError",
           "createdAt", "deliveredAt", "payload"
    FROM "NotificationEvent"
    WHERE "id" = ${eventId}
  `;
  const row = rows[0];
  if (!row) return null;

  const attempts = await ctx.db.$queryRaw<AttemptView[]>`
    SELECT "id", "attemptNumber", "startedAt", "finishedAt", "outcome", "httpStatus", "error"
    FROM "NotificationAttempt"
    WHERE "eventId" = ${eventId}
    ORDER BY "attemptNumber" ASC
  `;
  return { ...row, attempts };
}

/**
 * Requeue a NEEDS_ATTENTION event (after the operator corrected the cause).
 * The update is conditional on current status so concurrent calls are safe.
 */
export async function requeueEvent(ctx: AppContext, eventId: string): Promise<EventDetail> {
  const now = ctx.clock.now();
  const updated = await ctx.db.$queryRaw<Array<{ id: string }>>`
    UPDATE "NotificationEvent"
    SET "status" = 'PENDING'::"NotificationEventStatus",
        "nextAttemptAt" = ${now},
        "leaseToken" = NULL,
        "leaseUntil" = NULL
    WHERE "id" = ${eventId}
      AND "status" = 'NEEDS_ATTENTION'::"NotificationEventStatus"
    RETURNING "id"
  `;
  if (updated.length === 0) {
    const detail = await getEventDetail(ctx, eventId);
    if (!detail) throw appErrors.notFound('Notification event not found.');
    throw appErrors.notNeedsAttention(
      `Event is ${detail.status}; only NEEDS_ATTENTION events can be requeued.`,
    );
  }
  const detail = await getEventDetail(ctx, eventId);
  if (!detail) throw appErrors.notFound('Notification event not found.');
  return detail;
}
