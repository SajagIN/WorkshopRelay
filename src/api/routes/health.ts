import { Router } from 'express';
import type { Db } from '../../db/client';

export function createHealthRouter(db: Db): Router {
  const router = Router();

  router.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', service: 'api', time: new Date().toISOString() });
  });

  router.get('/health/ready', async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', database: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'down', time: new Date().toISOString() });
    }
  });

  return router;
}
