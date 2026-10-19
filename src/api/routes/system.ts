/**
 * Aggregated system status for the dashboard: database readiness, mock
 * reachability, and worker heartbeats (persisted by each worker loop tick).
 */
import { Router } from 'express';
import type { AppContext } from '../app';

export function createSystemRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/system/status', async (_req, res) => {
    const now = ctx.clock.now();

    let database: 'up' | 'down' = 'down';
    try {
      await ctx.db.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    let mock: { reachable: boolean; latencyMs: number | null; info?: unknown } = {
      reachable: false,
      latencyMs: null,
    };
    const t0 = Date.now();
    try {
      const resp = await fetch(`${ctx.config.mockNotificationUrl}/health/live`, {
        signal: AbortSignal.timeout(2_000),
      });
      mock = {
        reachable: resp.ok,
        latencyMs: Date.now() - t0,
        info: resp.ok ? await resp.json().catch(() => null) : undefined,
      };
    } catch {
      mock = { reachable: false, latencyMs: null };
    }

    const heartbeats = await ctx.db.$queryRaw<
      Array<{ workerId: string; pid: number | null; startedAt: Date; lastSeenAt: Date }>
    >`
      SELECT "workerId", "pid", "startedAt", "lastSeenAt"
      FROM "WorkerHeartbeat"
      ORDER BY "lastSeenAt" DESC
      LIMIT 20
    `;

    res.json({
      time: now.toISOString(),
      database,
      mock,
      workers: heartbeats.map((h) => ({
        ...h,
        secondsSinceLastSeen: Math.max(0, Math.round((now.getTime() - h.lastSeenAt.getTime()) / 1000)),
        // A worker is considered live if it checked in within 3 poll intervals
        // of the configured poll (generous 15s floor).
        live: now.getTime() - h.lastSeenAt.getTime() < Math.max(15_000, ctx.config.workerPollMs * 6),
      })),
      config: {
        workerPollMs: ctx.config.workerPollMs,
        workerLeaseMs: ctx.config.workerLeaseMs,
        workerConcurrency: ctx.config.workerConcurrency,
        notificationTimeoutMs: ctx.config.notificationTimeoutMs,
        retryBaseMs: ctx.config.retryBaseMs,
        retryCapMs: ctx.config.retryCapMs,
        enableDemoFaults: ctx.config.enableDemoFaults,
        enableDemoPersonas: ctx.config.enableDemoPersonas,
      },
    });
  });

  return router;
}
