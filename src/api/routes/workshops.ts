import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app';
import { getIdentity, requireMember, requireOrganizer } from '../middleware/auth';
import { parseOrThrow, routeParam } from '../middleware/validate';
import { appErrors } from '../../shared/errors';
import {
  cancelWorkshop,
  createWorkshop,
  getWorkshopDetail,
  listRegistrations,
  listWorkshops,
  notificationStatusForWorkshop,
  registerForWorkshop,
} from '../services/workshopService';

const createWorkshopSchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(160, 'title must be at most 160 characters'),
  description: z
    .string()
    .trim()
    .max(2000, 'description must be at most 2000 characters')
    .nullish()
    .transform((v) => (v == null || v === '' ? null : v)),
  scheduledAt: z
    .string()
    .min(1, 'scheduledAt is required')
    .refine((s) => !Number.isNaN(Date.parse(s)), 'scheduledAt must be an ISO-8601 datetime')
    .transform((s) => new Date(s)),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
});

const rosterQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export function createWorkshopsRouter(ctx: AppContext): Router {
  const router = Router();

  // POST /api/workshops — Organizer
  router.post('/workshops', requireOrganizer, async (req, res) => {
    const input = parseOrThrow(createWorkshopSchema, req.body);
    const identity = getIdentity(req);
    const workshop = await createWorkshop(ctx, input, identity.label);
    res.status(201).json(workshop);
  });

  // GET /api/workshops — any authenticated identity
  router.get('/workshops', async (req, res) => {
    const query = parseOrThrow(listQuerySchema, req.query);
    const { items, total } = await listWorkshops(ctx, {
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
    res.json({ items, total, limit: query.limit, offset: query.offset });
  });

  // GET /api/workshops/:id — details or 404
  router.get('/workshops/:id', async (req, res) => {
    const identity = getIdentity(req);
    const detail = await getWorkshopDetail(ctx, routeParam(req, 'id'), identity.memberId);
    if (!detail) throw appErrors.notFound('Workshop not found.');
    res.json(detail);
  });

  // POST /api/workshops/:id/registrations — Member; 201 after commit
  router.post('/workshops/:id/registrations', requireMember, async (req, res) => {
    const identity = getIdentity(req);
    const member = await ctx.db.member.findUnique({ where: { id: identity.memberId! } });
    if (!member) throw appErrors.notFound('Member profile not found for this identity.');

    const result = await registerForWorkshop(ctx, routeParam(req, 'id'), {
      id: member.id,
      displayName: member.displayName,
      notificationAddress: member.notificationAddress,
    });
    res.status(201).json(result);
  });

  // GET /api/workshops/:id/registrations — Organizer roster
  router.get('/workshops/:id/registrations', requireOrganizer, async (req, res) => {
    const query = parseOrThrow(rosterQuerySchema, req.query);
    const { items, total } = await listRegistrations(ctx, routeParam(req, 'id'), query);
    res.json({ items, total, limit: query.limit, offset: query.offset });
  });

  // POST /api/workshops/:id/cancel — Organizer; repeat calls return 200
  router.post('/workshops/:id/cancel', requireOrganizer, async (req, res) => {
    const result = await cancelWorkshop(ctx, routeParam(req, 'id'));
    res.status(200).json(result);
  });

  // GET /api/workshops/:id/notification-status — Organizer
  router.get('/workshops/:id/notification-status', requireOrganizer, async (req, res) => {
    const summary = await notificationStatusForWorkshop(ctx, routeParam(req, 'id'));
    res.json(summary);
  });

  return router;
}
