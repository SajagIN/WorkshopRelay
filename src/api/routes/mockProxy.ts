/**
 * Organizer-only proxy to the mock notification service's admin surface.
 * The dashboard calls these same-origin routes; the API forwards them to the
 * mock service server-to-server with the admin token. Browser code never
 * talks to the mock service's port directly.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireOrganizer } from '../middleware/auth';
import { parseOrThrow } from '../middleware/validate';
import { appErrors } from '../../shared/errors';

const faultSchema = z.object({
  mode: z.enum([
    'always_success',
    'fail_first_n',
    'always_503',
    'always_400',
    'timeout_before_commit',
    'commit_then_timeout',
    'seeded_random',
  ]),
  scope: z
    .object({
      kind: z.enum(['global', 'recipient', 'event']),
      recipientId: z.string().min(1).optional(),
      eventId: z.string().min(1).optional(),
    })
    .default({ kind: 'global' }),
  failFirstN: z.coerce.number().int().min(0).max(1000).optional(),
  hangMs: z.coerce.number().int().min(1).max(120_000).optional(),
  failureRate: z.coerce.number().min(0).max(1).optional(),
  seed: z.coerce.number().int().optional(),
});

const resetSchema = z.object({
  clearReceipts: z.boolean().default(false),
});

async function proxyJson(
  ctx: AppContext,
  res: Response,
  init: {
    method: string;
    path: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
  },
): Promise<void> {
  const url = new URL(ctx.config.mockNotificationUrl + init.path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.config.mockAdminToken}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw appErrors.mockUnreachable();
  }

  const text = await response.text();
  res.status(response.status);
  const contentType = response.headers.get('content-type') ?? 'application/json';
  res.setHeader('content-type', contentType);
  res.send(text);
}

export function createMockProxyRouter(ctx: AppContext): Router {
  const router = Router();
  router.use('/mock', requireOrganizer);

  // GET /api/mock/receipts
  router.get('/mock/receipts', async (req, res) => {
    await proxyJson(ctx, res, {
      method: 'GET',
      path: '/receipts',
      query: {
        limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
        eventId: typeof req.query.eventId === 'string' ? req.query.eventId : undefined,
        recipientId: typeof req.query.recipientId === 'string' ? req.query.recipientId : undefined,
        idempotencyKey:
          typeof req.query.idempotencyKey === 'string' ? req.query.idempotencyKey : undefined,
      },
    });
  });

  // GET /api/mock/faults — current fault configuration
  router.get('/mock/faults', async (_req, res) => {
    await proxyJson(ctx, res, { method: 'GET', path: '/admin/faults' });
  });

  // PUT /api/mock/faults — configure faults (test/demo only)
  router.put('/mock/faults', async (req, res) => {
    const body = parseOrThrow(faultSchema, req.body);
    await proxyJson(ctx, res, { method: 'PUT', path: '/admin/faults', body });
  });

  // POST /api/mock/reset — clear test fixtures (test/demo only)
  router.post('/mock/reset', async (req, res) => {
    const body = parseOrThrow(resetSchema, req.body ?? {});
    await proxyJson(ctx, res, { method: 'POST', path: '/admin/reset', body });
  });

  // GET /api/mock/stats — counters for the dashboard
  router.get('/mock/stats', async (_req, res) => {
    await proxyJson(ctx, res, { method: 'GET', path: '/admin/stats' });
  });

  return router;
}
