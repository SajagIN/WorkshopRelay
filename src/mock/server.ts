/**
 * Mock HTTP notification service.
 *
 * - POST /notifications  accepts synthetic deliveries (idempotent by key)
 * - GET  /receipts       durable delivery evidence (admin)
 * - PUT  /admin/faults   fault configuration (admin, demo mode only)
 * - POST /admin/reset    clear test fixtures (admin, demo mode only)
 * - GET  /admin/stats    counters (admin)
 * - GET  /health/live    liveness
 *
 * The mock NEVER reads outbox state: a delivery succeeds only if this service
 * processes it. Receipts are durable in PostgreSQL, so duplicate suppression
 * survives mock restarts.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Db } from '../db/client';
import type { Config } from '../shared/config';
import type { Logger } from '../shared/logger';
import type { Clock } from '../shared/clock';
import { appErrors, errorEnvelope, AppError } from '../shared/errors';
import { payloadHash } from '../domain/events';
import { truncate } from '../domain/retryPolicy';
import { Prisma } from '../generated/prisma/client';
import { FaultController, type FaultState, FAULT_MODES } from './faults';

export interface MockContext {
  db: Db;
  config: Config;
  logger: Logger;
  clock: Clock;
  faults: FaultController;
}

const deliveryBodySchema = z.object({
  eventId: z.string().min(1).max(100),
  type: z.enum(['REGISTRATION_CONFIRMED', 'WORKSHOP_CANCELLED']),
  recipientId: z.string().min(1).max(100),
  payloadVersion: z.number().int().min(1).max(1000),
  message: z.record(z.string(), z.unknown()),
});

const faultSchema = z.object({
  mode: z.enum(FAULT_MODES as unknown as [FaultState['mode'], ...FaultState['mode'][]]),
  scope: z
    .object({
      kind: z.enum(['global', 'recipient', 'event']),
      recipientId: z.string().min(1).optional(),
      eventId: z.string().min(1).optional(),
    })
    .default({ kind: 'global' }),
  failFirstN: z.number().int().min(0).max(1000).optional(),
  hangMs: z.number().int().min(1).max(120_000).optional(),
  failureRate: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
});

const resetSchema = z.object({
  clearReceipts: z.boolean().default(false),
});

interface Counters {
  received: number;
  accepted: number;
  duplicatesSuppressed: number;
  payloadMismatches: number;
  faultsInjected: number;
}

interface ReceiptResult {
  outcome: 'created' | 'duplicate';
  idempotencyKey: string;
  receivedAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireBearer(expected: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || match[1].trim() !== expected) {
      next(appErrors.unauthorized('Missing or invalid service token.'));
      return;
    }
    next();
  };
}

export function createMockApp(ctx: MockContext) {
  const { db, config, logger, clock, faults } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));

  const counters: Counters = {
    received: 0,
    accepted: 0,
    duplicatesSuppressed: 0,
    payloadMismatches: 0,
    faultsInjected: 0,
  };

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: 'mock', time: clock.now().toISOString() });
  });

  // -------------------------------------------------------------------------
  // Delivery endpoint
  // -------------------------------------------------------------------------

  /**
   * Atomic receipt upsert — the core "logical delivery" operation.
   * Same key + same payload → duplicate success; different payload → 409.
   */
  async function upsertReceipt(idempotencyKey: string, body: unknown): Promise<ReceiptResult> {
    const now = clock.now();
    const hash = payloadHash(body);
    const inserted = await db.$queryRaw<Array<{ idempotencyKey: string }>>`
      INSERT INTO "MockDeliveryReceipt" ("idempotencyKey", "payloadHash", "payload", "receivedAt")
      VALUES (${idempotencyKey}, ${hash}, ${JSON.stringify(body)}::jsonb, ${now})
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING "idempotencyKey"
    `;
    if (inserted.length > 0) {
      counters.accepted += 1;
      return { outcome: 'created', idempotencyKey, receivedAt: now.toISOString() };
    }

    const existing = await db.$queryRaw<Array<{ payloadHash: string; receivedAt: Date }>>`
      SELECT "payloadHash", "receivedAt" FROM "MockDeliveryReceipt"
      WHERE "idempotencyKey" = ${idempotencyKey}
    `;
    const row = existing[0];
    if (row && row.payloadHash !== hash) {
      counters.payloadMismatches += 1;
      throw appErrors.idempotencyPayloadMismatch();
    }
    counters.duplicatesSuppressed += 1;
    return {
      outcome: 'duplicate',
      idempotencyKey,
      receivedAt: (row?.receivedAt ?? now).toISOString(),
    };
  }

  app.post(
    '/notifications',
    requireBearer(config.mockAuthToken),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const idempotencyKey = req.header('idempotency-key')?.trim();
        if (!idempotencyKey) {
          throw appErrors.missingIdempotencyKey();
        }
        const parsed = deliveryBodySchema.safeParse(req.body);
        if (!parsed.success) {
          throw appErrors.validation('Invalid delivery body.', {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          });
        }
        const body = parsed.data;
        counters.received += 1;

        const decision = faults.evaluate({ eventId: body.eventId, recipientId: body.recipientId });
        logger.info('mock delivery received', {
          eventId: body.eventId,
          idempotencyKey,
          faultMode: faults.getState().mode,
          decision: decision.action,
        });

        if (decision.action === 'fail') {
          counters.faultsInjected += 1;
          if (decision.retryAfterSec != null) {
            res.setHeader('Retry-After', String(decision.retryAfterSec));
          }
          res.status(decision.status).json(
            errorEnvelope(
              'INTERNAL_ERROR',
              truncate(`Injected fault: ${decision.reason}`, 200),
              idempotencyKey,
            ),
          );
          return;
        }

        if (decision.action === 'hang') {
          counters.faultsInjected += 1;
          if (decision.commitFirst) {
            // Ambiguous outcome: receipt commits, response is lost.
            const receipt = await upsertReceipt(idempotencyKey, body);
            logger.info('mock committed receipt then hanging', {
              eventId: body.eventId,
              hangMs: decision.hangMs,
              receiptOutcome: receipt.outcome,
            });
            await sleep(decision.hangMs);
            // The client has usually timed out by now; still respond correctly.
            res.status(receipt.outcome === 'created' ? 201 : 200).json({
              status: 'accepted',
              duplicate: receipt.outcome === 'duplicate',
              idempotencyKey,
              receivedAt: receipt.receivedAt,
              late: true,
            });
            return;
          }
          // timeout_before_commit: hang first, never write a receipt.
          logger.info('mock hanging before commit', {
            eventId: body.eventId,
            hangMs: decision.hangMs,
          });
          await sleep(decision.hangMs);
          res.status(503).json(
            errorEnvelope(
              'INTERNAL_ERROR',
              'Injected fault: timed out before commit (no receipt written).',
              idempotencyKey,
            ),
          );
          return;
        }

        const receipt = await upsertReceipt(idempotencyKey, body);
        res.status(receipt.outcome === 'created' ? 201 : 200).json({
          status: 'accepted',
          duplicate: receipt.outcome === 'duplicate',
          idempotencyKey,
          receivedAt: receipt.receivedAt,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Admin surface
  // -------------------------------------------------------------------------

  const authAdmin = requireBearer(config.mockAdminToken);

  function requireFaultsEnabled(_req: Request, _res: Response, next: NextFunction): void {
    if (!config.enableDemoFaults) {
      next(appErrors.faultsDisabled());
      return;
    }
    next();
  }

  app.get('/receipts', authAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = clampInt(req.query.limit, 50, 1, 200);
      const clauses: ReturnType<typeof Prisma.sql>[] = [];
      if (typeof req.query.eventId === 'string' && req.query.eventId) {
        clauses.push(Prisma.sql`"payload"->>'eventId' = ${req.query.eventId}`);
      }
      if (typeof req.query.recipientId === 'string' && req.query.recipientId) {
        clauses.push(Prisma.sql`"payload"->>'recipientId' = ${req.query.recipientId}`);
      }
      if (typeof req.query.idempotencyKey === 'string' && req.query.idempotencyKey) {
        clauses.push(Prisma.sql`"idempotencyKey" = ${req.query.idempotencyKey}`);
      }
      const where = clauses.length > 0 ? Prisma.join(clauses, ' AND ') : Prisma.sql`TRUE`;

      const rows = await db.$queryRaw<
        Array<{ idempotencyKey: string; payloadHash: string; payload: unknown; receivedAt: Date }>
      >`
        SELECT "idempotencyKey", "payloadHash", "payload", "receivedAt"
        FROM "MockDeliveryReceipt"
        WHERE ${where}
        ORDER BY "receivedAt" DESC
        LIMIT ${limit}
      `;
      const totalRows = await db.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM "MockDeliveryReceipt"
      `;
      res.json({ items: rows, total: Number(totalRows[0]?.count ?? 0) });
    } catch (err) {
      next(err);
    }
  });

  app.get('/admin/faults', authAdmin, (_req, res) => {
    res.json({ enabled: config.enableDemoFaults, state: faults.getState() });
  });

  app.put(
    '/admin/faults',
    authAdmin,
    requireFaultsEnabled,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = faultSchema.safeParse(req.body);
        if (!parsed.success) {
          throw appErrors.validation('Invalid fault configuration.', {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          });
        }
        const input = parsed.data;
        if (input.scope.kind === 'recipient' && !input.scope.recipientId) {
          throw appErrors.validation('scope.recipientId is required for recipient scope.');
        }
        if (input.scope.kind === 'event' && !input.scope.eventId) {
          throw appErrors.validation('scope.eventId is required for event scope.');
        }
        const state = faults.setRule({
          mode: input.mode,
          scope: input.scope,
          failFirstN: input.failFirstN,
          hangMs: input.hangMs,
          failureRate: input.failureRate,
          seed: input.seed,
        });
        logger.info('fault rule updated', { state });
        res.json({ enabled: true, state });
      } catch (err) {
        next(err);
      }
    },
  );

  app.post(
    '/admin/reset',
    authAdmin,
    requireFaultsEnabled,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = resetSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw appErrors.validation('Invalid reset body.');
        }
        faults.clear();
        let deletedReceipts = 0;
        if (parsed.data.clearReceipts) {
          const rows = await db.$queryRaw<Array<{ idempotencyKey: string }>>`
            DELETE FROM "MockDeliveryReceipt" RETURNING "idempotencyKey"
          `;
          deletedReceipts = rows.length;
        }
        counters.received = 0;
        counters.accepted = 0;
        counters.duplicatesSuppressed = 0;
        counters.payloadMismatches = 0;
        counters.faultsInjected = 0;
        logger.info('mock reset', { deletedReceipts });
        res.json({ ok: true, deletedReceipts });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get('/admin/stats', authAdmin, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const totalRows = await db.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM "MockDeliveryReceipt"
      `;
      res.json({
        counters,
        receiptCount: Number(totalRows[0]?.count ?? 0),
        faultState: faults.getState(),
      });
    } catch (err) {
      next(err);
    }
  });

  // Error envelope
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.header('x-request-id') ?? 'mock';
    if (err instanceof AppError) {
      res.status(err.status).json(errorEnvelope(err.code, err.message, requestId));
      return;
    }
    const anyErr = err as { type?: string } | null;
    if (anyErr && anyErr.type === 'entity.too.large') {
      res.status(413).json(errorEnvelope('PAYLOAD_TOO_LARGE', 'Body too large.', requestId));
      return;
    }
    if (anyErr && anyErr.type === 'entity.parse.failed') {
      res.status(400).json(errorEnvelope('INVALID_JSON', 'Invalid JSON body.', requestId));
      return;
    }
    logger.error('mock unhandled error', { err, requestId });
    res.status(500).json(errorEnvelope('INTERNAL_ERROR', 'Mock service error.', requestId));
  });

  return app;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
