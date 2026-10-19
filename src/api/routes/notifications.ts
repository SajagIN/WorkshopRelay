import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../app';
import { requireOrganizer } from '../middleware/auth';
import { parseOrThrow, routeParam } from '../middleware/validate';
import { appErrors } from '../../shared/errors';
import { getEventDetail, listEvents, requeueEvent } from '../services/notificationService';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['PENDING', 'PROCESSING', 'DELIVERED', 'NEEDS_ATTENTION']).optional(),
  type: z.enum(['REGISTRATION_CONFIRMED', 'WORKSHOP_CANCELLED']).optional(),
  workshopId: z.string().min(1).optional(),
  search: z.string().max(120).optional(),
});

export function createNotificationsRouter(ctx: AppContext): Router {
  const router = Router();

  // GET /api/notifications — filterable cross-workshop event list (organizer)
  router.get('/notifications', requireOrganizer, async (req, res) => {
    const query = parseOrThrow(listQuerySchema, req.query);
    const result = await listEvents(ctx, query);
    res.json({
      ...result,
      limit: query.limit,
      offset: query.offset,
    });
  });

  // GET /api/notifications/:eventId — event state + sanitized attempt history
  router.get('/notifications/:eventId', requireOrganizer, async (req, res) => {
    const detail = await getEventDetail(ctx, routeParam(req, 'eventId'));
    if (!detail) throw appErrors.notFound('Notification event not found.');
    res.json(detail);
  });

  // POST /api/notifications/:eventId/retry — requeue a corrected NEEDS_ATTENTION job
  router.post('/notifications/:eventId/retry', requireOrganizer, async (req, res) => {
    const detail = await requeueEvent(ctx, routeParam(req, 'eventId'));
    res.json(detail);
  });

  return router;
}
