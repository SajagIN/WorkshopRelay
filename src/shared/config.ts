/**
 * Central configuration. Every tunable from the PRD lives here, is validated,
 * and is documented in .env.example. Tests construct Config objects directly
 * via `parseConfig(envOverrides)`.
 */
import 'dotenv/config';
import { z } from 'zod';

const boolish = z.preprocess((v) => {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  }
  return v;
}, z.boolean());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_URL_TEST: z.string().optional(),

  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  API_CORS_ORIGINS: z.string().default(''),

  MOCK_HOST: z.string().default('0.0.0.0'),
  MOCK_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  MOCK_NOTIFICATION_URL: z.string().default('http://127.0.0.1:4100'),
  MOCK_AUTH_TOKEN: z.string().min(1).default('mock-service-token'),
  MOCK_ADMIN_TOKEN: z.string().min(1).default('mock-admin-token'),

  ORGANIZER_TOKEN: z.string().min(1).default('organizer-demo-token'),
  MEMBER_TOKENS: z.string().default(
    'alice:alice-demo-token,bob:bob-demo-token,carol:carol-demo-token,dave:dave-demo-token',
  ),

  WORKER_ID: z.string().default('worker-1'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(5),
  WORKER_POLL_MS: z.coerce.number().int().min(10).default(500),
  WORKER_LEASE_MS: z.coerce.number().int().min(100).default(15_000),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),

  NOTIFICATION_TIMEOUT_MS: z.coerce.number().int().min(10).default(3_000),
  RETRY_BASE_MS: z.coerce.number().int().min(1).default(1_000),
  RETRY_CAP_MS: z.coerce.number().int().min(1).default(60_000),
  RETRY_MIN_MS: z.coerce.number().int().min(1).default(100),
  RETRY_AFTER_MAX_MS: z.coerce.number().int().min(1).default(300_000),
  RETRY_ALERT_AFTER_ATTEMPTS: z.coerce.number().int().min(1).default(10),

  ENABLE_DEMO_FAULTS: boolish.default(true),
  ENABLE_DEMO_PERSONAS: boolish.default(true),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface MemberTokenEntry {
  label: string;
  token: string;
}

export interface Config {
  databaseUrl: string;
  databaseUrlTest: string | undefined;

  apiHost: string;
  apiPort: number;
  apiCorsOrigins: string[];

  mockHost: string;
  mockPort: number;
  mockNotificationUrl: string;
  mockAuthToken: string;
  mockAdminToken: string;

  organizerToken: string;
  memberTokens: MemberTokenEntry[];

  workerId: string;
  workerConcurrency: number;
  workerPollMs: number;
  workerLeaseMs: number;
  workerBatchSize: number;

  notificationTimeoutMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  retryMinMs: number;
  retryAfterMaxMs: number;
  retryAlertAfterAttempts: number;

  enableDemoFaults: boolean;
  enableDemoPersonas: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {}

function parseMemberTokens(raw: string): MemberTokenEntry[] {
  const entries: MemberTokenEntry[] = [];
  const seenTokens = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0 || idx === trimmed.length - 1) {
      throw new ConfigError(
        `MEMBER_TOKENS entry "${trimmed}" must have the form label:token`,
      );
    }
    const label = trimmed.slice(0, idx).trim();
    const token = trimmed.slice(idx + 1).trim();
    if (!label || !token) {
      throw new ConfigError(`MEMBER_TOKENS entry "${trimmed}" is malformed`);
    }
    if (seenTokens.has(token)) {
      throw new ConfigError(`MEMBER_TOKENS contains duplicate token for "${label}"`);
    }
    seenTokens.add(token);
    entries.push({ label, token });
  }
  return entries;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;

  const memberTokens = parseMemberTokens(e.MEMBER_TOKENS);
  const allTokens = [e.ORGANIZER_TOKEN, ...memberTokens.map((m) => m.token)];
  if (new Set(allTokens).size !== allTokens.length) {
    throw new ConfigError('Organizer and member tokens must be unique');
  }

  return {
    databaseUrl: e.DATABASE_URL,
    databaseUrlTest: e.DATABASE_URL_TEST,

    apiHost: e.API_HOST,
    apiPort: e.API_PORT,
    apiCorsOrigins: e.API_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    mockHost: e.MOCK_HOST,
    mockPort: e.MOCK_PORT,
    mockNotificationUrl: e.MOCK_NOTIFICATION_URL.replace(/\/$/, ''),
    mockAuthToken: e.MOCK_AUTH_TOKEN,
    mockAdminToken: e.MOCK_ADMIN_TOKEN,

    organizerToken: e.ORGANIZER_TOKEN,
    memberTokens,

    workerId: e.WORKER_ID,
    workerConcurrency: e.WORKER_CONCURRENCY,
    workerPollMs: e.WORKER_POLL_MS,
    workerLeaseMs: e.WORKER_LEASE_MS,
    workerBatchSize: e.WORKER_BATCH_SIZE,

    notificationTimeoutMs: e.NOTIFICATION_TIMEOUT_MS,
    retryBaseMs: e.RETRY_BASE_MS,
    retryCapMs: e.RETRY_CAP_MS,
    retryMinMs: e.RETRY_MIN_MS,
    retryAfterMaxMs: e.RETRY_AFTER_MAX_MS,
    retryAlertAfterAttempts: e.RETRY_ALERT_AFTER_ATTEMPTS,

    enableDemoFaults: e.ENABLE_DEMO_FAULTS,
    enableDemoPersonas: e.ENABLE_DEMO_PERSONAS,
    logLevel: e.LOG_LEVEL,
  };
}
