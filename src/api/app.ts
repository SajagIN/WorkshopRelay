/**
 * Express app factory. Kept free of `listen` so tests can drive it with
 * supertest. The dashboard is served same-origin from /public.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Db } from '../db/client';
import type { Config } from '../shared/config';
import type { Logger } from '../shared/logger';
import type { Clock } from '../shared/clock';
import { appErrors } from '../shared/errors';
import { requestIdMiddleware } from './middleware/requestId';
import { createAuthMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { createHealthRouter } from './routes/health';
import { createWorkshopsRouter } from './routes/workshops';
import { createNotificationsRouter } from './routes/notifications';
import { createMockProxyRouter } from './routes/mockProxy';
import { createSystemRouter } from './routes/system';
import { createDemoRouter } from './routes/demo';

export interface AppContext {
  db: Db;
  config: Config;
  logger: Logger;
  clock: Clock;
}

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

export function createApp(ctx: AppContext): Express {
  const { db, config, logger } = ctx;
  const app = express();

  app.disable('x-powered-by');
  app.use(requestIdMiddleware);

  // Optional CORS (dashboard is same-origin; allowlisted origins only).
  if (config.apiCorsOrigins.length > 0) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.header('origin');
      if (origin && config.apiCorsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id, Idempotency-Key');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
    });
  }

  app.use(express.json({ limit: '64kb' }));

  app.use(createHealthRouter(db));

  const authenticate = createAuthMiddleware(db, config);
  // Demo router first: /api/demo/personas is intentionally public (persona
  // listing for the dashboard); its other routes apply auth selectively.
  app.use('/api', createDemoRouter(ctx, authenticate));
  app.use('/api', authenticate, createWorkshopsRouter(ctx));
  app.use('/api', authenticate, createNotificationsRouter(ctx));
  app.use('/api', authenticate, createMockProxyRouter(ctx));
  app.use('/api', authenticate, createSystemRouter(ctx));

  // Dashboard (same-origin static assets; no external CDNs).
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));

  // SPA fallback for non-API GETs.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/health')) {
      res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
        if (err) next(err);
      });
      return;
    }
    next();
  });

  // Unknown API routes → envelope 404.
  app.use('/api', (req, _res, next) => {
    next(appErrors.notFound(`No API route for ${req.method} ${req.path}`));
  });

  app.use(errorHandler(logger));
  return app;
}
