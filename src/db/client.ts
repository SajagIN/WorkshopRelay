/**
 * Database access. Prisma 7 with the pg driver adapter.
 *
 * Naming convention: tables/columns keep Prisma's default PascalCase/camelCase
 * names, so raw SQL quotes identifiers like "NotificationEvent"."nextAttemptAt".
 * All timestamp columns are TIMESTAMPTZ — absolute instants, session-TZ safe.
 */
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

export type Db = PrismaClient;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  /** Close client and pool (graceful shutdown). */
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, poolMax = 10): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: poolMax,
    statement_timeout: 30_000,
    // Session presentation in UTC (columns are TIMESTAMPTZ either way).
    options: '-c timezone=UTC',
  });

  const adapter = new PrismaPg(pool);
  const db = new PrismaClient({ adapter });

  return {
    db,
    pool,
    async close() {
      await db.$disconnect();
      await pool.end();
    },
  };
}
