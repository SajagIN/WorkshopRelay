/**
 * Independent notification worker (PRD §6, §9).
 *
 * Loop: claim due events (bounded batch) → POST to the notification service
 * with bounded concurrency → mark delivered / schedule retry / park as
 * NEEDS_ATTENTION. HTTP happens outside any database transaction. Retryable
 * failures are retried indefinitely with capped full-jitter backoff; one
 * recipient's failure never blocks another's progress.
 */
import type { Db } from '../db/client';
import type { Config } from '../shared/config';
import type { Logger } from '../shared/logger';
import type { Clock } from '../shared/clock';
import { systemClock } from '../shared/clock';
import { mapPool } from '../shared/concurrency';
import { buildDeliveryBody } from '../domain/events';
import { computeBackoffMs, truncate } from '../domain/retryPolicy';
import {
  claimDueEvents,
  markDelivered,
  settleRetry,
  upsertWorkerHeartbeat,
} from '../db/outbox';
import type { NotificationSender } from './sender';

export interface WorkerDeps {
  db: Db;
  config: Config;
  logger: Logger;
  clock?: Clock;
  sender: NotificationSender;
  /** Injectable RNG for backoff (tests). */
  random?: () => number;
}

export interface RunStats {
  claimed: number;
  delivered: number;
  retried: number;
  needsAttention: number;
  stale: number;
}

const ZERO_STATS: RunStats = {
  claimed: 0,
  delivered: 0,
  retried: 0,
  needsAttention: 0,
  stale: 0,
};

export class NotificationWorker {
  readonly workerId: string;
  private readonly db: Db;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly sender: NotificationSender;
  private readonly random: () => number;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private stopped: (() => void) | null = null;

  constructor(deps: WorkerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger.child({ workerId: deps.config.workerId });
    this.clock = deps.clock ?? systemClock;
    this.sender = deps.sender;
    this.random = deps.random ?? Math.random;
    this.workerId = deps.config.workerId;
  }

  /** One claim-process-settle cycle. Returns delivery stats. */
  async runOnce(): Promise<RunStats> {
    const now = this.clock.now();
    await upsertWorkerHeartbeat(this.db, { workerId: this.workerId, pid: process.pid, now });

    const claimed = await claimDueEvents(this.db, {
      limit: this.config.workerBatchSize,
      leaseMs: this.config.workerLeaseMs,
      now,
    });
    if (claimed.length === 0) return { ...ZERO_STATS };

    const stats: RunStats = { ...ZERO_STATS, claimed: claimed.length };

    await mapPool(claimed, this.config.workerConcurrency, async (event) => {
      const log = this.logger.child({
        eventId: event.id,
        eventType: event.type,
        recipientId: event.recipientId,
        attempt: event.attemptCount,
      });

      const body = buildDeliveryBody(event.id, event.type, event.recipientId, event.payload);
      const startedAt = Date.now();
      const outcome = await this.sender.send(body, event.id);
      const durationMs = Date.now() - startedAt;

      if (event.attemptCount >= this.config.retryAlertAfterAttempts) {
        log.warn('retry threshold exceeded; continuing to retry', {
          attemptCount: event.attemptCount,
        });
      }

      if (outcome.kind === 'success') {
        const result = await markDelivered(this.db, {
          eventId: event.id,
          leaseToken: event.claimToken,
          attemptId: event.attemptId,
          httpStatus: outcome.httpStatus,
          now: this.clock.now(),
        });
        if (result.fenced) {
          stats.delivered += 1;
          log.info('notification delivered', {
            outcome: 'DELIVERED',
            httpStatus: outcome.httpStatus,
            durationMs,
          });
        } else {
          stats.stale += 1;
          log.warn('delivery succeeded but lease was lost; result ignored', {
            outcome: 'STALE_LEASE',
            httpStatus: outcome.httpStatus,
          });
        }
        return;
      }

      if (outcome.kind === 'transient') {
        const backoffMs = computeBackoffMs(event.attemptCount, {
          baseMs: this.config.retryBaseMs,
          capMs: this.config.retryCapMs,
          minMs: this.config.retryMinMs,
          random: this.random,
          retryAfterMs: outcome.retryAfterMs,
          retryAfterMaxMs: this.config.retryAfterMaxMs,
        });
        const nextAttemptAt = new Date(this.clock.now().getTime() + backoffMs);
        const error = truncate(outcome.error, 500);
        const result = await settleRetry(this.db, {
          eventId: event.id,
          leaseToken: event.claimToken,
          attemptId: event.attemptId,
          outcome: 'RETRY_SCHEDULED',
          nextAttemptAt,
          error,
          httpStatus: outcome.httpStatus,
          now: this.clock.now(),
        });
        if (result.fenced) {
          stats.retried += 1;
          log.info('transient failure; retry scheduled', {
            outcome: 'RETRY_SCHEDULED',
            httpStatus: outcome.httpStatus,
            error,
            backoffMs,
            nextAttemptAt: nextAttemptAt.toISOString(),
            durationMs,
          });
        } else {
          stats.stale += 1;
          log.warn('lease lost before retry scheduling', { outcome: 'STALE_LEASE' });
        }
        return;
      }

      // Permanent failure → visible NEEDS_ATTENTION (operator intervention).
      const error = truncate(outcome.error, 500);
      const result = await settleRetry(this.db, {
        eventId: event.id,
        leaseToken: event.claimToken,
        attemptId: event.attemptId,
        outcome: 'NEEDS_ATTENTION',
        nextAttemptAt: this.clock.now(),
        error,
        httpStatus: outcome.httpStatus,
        now: this.clock.now(),
      });
      if (result.fenced) {
        stats.needsAttention += 1;
        log.warn('permanent failure; event parked as NEEDS_ATTENTION', {
          outcome: 'NEEDS_ATTENTION',
          httpStatus: outcome.httpStatus,
          error,
          durationMs,
        });
      } else {
        stats.stale += 1;
        log.warn('lease lost before settle', { outcome: 'STALE_LEASE' });
      }
    });

    return stats;
  }

  /** Start the background poll loop (returns immediately). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    this.logger.info('worker started', {
      pollMs: this.config.workerPollMs,
      concurrency: this.config.workerConcurrency,
      leaseMs: this.config.workerLeaseMs,
    });
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const stats = await this.runOnce();
        if (stats.claimed > 0) {
          this.logger.debug('worker cycle complete', { ...stats });
        }
      } catch (err) {
        this.logger.error('worker cycle failed', { err });
      }
      await this.sleepInterruptible(this.config.workerPollMs);
    }
    this.stopped?.();
  }

  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const prev = this.stopped;
      this.stopped = () => {
        clearTimeout(timer);
        prev?.();
        resolve();
      };
    });
  }

  /** Graceful stop: no new claims; waits for the current cycle to finish. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopped?.();
    await this.loopPromise;
    this.logger.info('worker stopped');
  }
}
