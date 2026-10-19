/**
 * Vitest global setup: apply migrations to the test database once per run.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default function globalSetup(): void {
  const testUrl =
    process.env.DATABASE_URL_TEST ??
    'postgresql://workshop:workshop_dev_password@127.0.0.1:5432/workshop_relay_test';

  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: testUrl },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate deploy (test db) failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}
