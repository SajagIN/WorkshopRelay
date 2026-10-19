/**
 * Demo-only persona listing so the dashboard can offer one-click identity
 * switching. DISABLE by setting ENABLE_DEMO_PERSONAS=false — then the UI's
 * manual token entry is the only way to authenticate.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppContext } from '../app';
import { getIdentity, requireOrganizer } from '../middleware/auth';

type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

export function createDemoRouter(ctx: AppContext, authenticate: Middleware): Router {
  const router = Router();

  router.get('/demo/personas', async (_req, res) => {
    if (!ctx.config.enableDemoPersonas) {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Persona listing is disabled.', requestId: res.locals.requestId },
      });
      return;
    }
    const identities = await ctx.db.demoIdentity.findMany({ orderBy: { label: 'asc' } });
    res.json({
      personas: identities.map((i) => ({
        label: i.label,
        role: i.role,
        memberId: i.memberId,
        token: i.token,
      })),
    });
  });

  // Who am I — handy for the UI badge.
  router.get('/demo/whoami', authenticate, (req, res) => {
    const identity = getIdentity(req);
    res.json({ label: identity.label, role: identity.role, memberId: identity.memberId });
  });

  // Organizer-only health alias used by the dashboard's roster guard.
  router.get('/demo/ping', authenticate, requireOrganizer, (_req, res) => {
    res.json({ ok: true });
  });

  return router;
}
