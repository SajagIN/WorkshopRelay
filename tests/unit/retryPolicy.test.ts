import { describe, expect, it } from 'vitest';
import {
  classifyHttpStatus,
  classifyThrownError,
  computeBackoffMs,
  parseRetryAfterMs,
} from '../../src/domain/retryPolicy';

const base = {
  baseMs: 100,
  capMs: 1000,
  minMs: 10,
  retryAfterMaxMs: 5000,
};

describe('computeBackoffMs (full jitter, capped, clamped)', () => {
  it('stays within [minMs, exponential cap] for early attempts', () => {
    for (const random of [() => 0, () => 0.5, () => 0.999999]) {
      const delay = computeBackoffMs(1, { ...base, random });
      expect(delay).toBeGreaterThanOrEqual(10);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });

  it('grows exponentially with attempts but never exceeds capMs', () => {
    const maxOf = (attempt: number) =>
      Math.max(
        ...Array.from({ length: 50 }, () =>
          computeBackoffMs(attempt, { ...base, random: () => 0.999999 }),
        ),
      );
    expect(maxOf(2)).toBeLessThanOrEqual(200);
    expect(maxOf(5)).toBeLessThanOrEqual(1000);
    expect(maxOf(20)).toBeLessThanOrEqual(1000); // capped
  });

  it('clamps to minMs even when jitter rolls zero (no hot loops)', () => {
    expect(computeBackoffMs(1, { ...base, random: () => 0 })).toBe(10);
    expect(computeBackoffMs(50, { ...base, random: () => 0 })).toBe(10);
  });

  it('honors Retry-After within bounds', () => {
    expect(computeBackoffMs(1, { ...base, random: () => 0, retryAfterMs: 250 })).toBe(250);
    // below minMs → clamped up
    expect(computeBackoffMs(1, { ...base, random: () => 0, retryAfterMs: 1 })).toBe(10);
    // above retryAfterMaxMs → clamped down
    expect(computeBackoffMs(1, { ...base, random: () => 0, retryAfterMs: 999_999 })).toBe(5000);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
  });

  it('parses HTTP dates relative to now', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    expect(parseRetryAfterMs('Sun, 01 Nov 2026 00:00:05 GMT', now)).toBe(5000);
  });

  it('returns null for garbage/absent values', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });
});

describe('classifyHttpStatus', () => {
  it('treats 2xx as success', () => {
    expect(classifyHttpStatus(200).kind).toBe('success');
    expect(classifyHttpStatus(201).kind).toBe('success');
  });

  it('treats 408/429/5xx as transient (retryable)', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyHttpStatus(status).kind).toBe('transient');
    }
  });

  it('treats other 4xx as permanent (NEEDS_ATTENTION)', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyHttpStatus(status).kind).toBe('permanent');
    }
  });
});

describe('classifyThrownError', () => {
  it('treats timeouts and connection failures as transient', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(classifyThrownError(abort).kind).toBe('transient');

    const conn = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(classifyThrownError(conn).kind).toBe('transient');

    expect(classifyThrownError(new TypeError('fetch failed')).kind).toBe('transient');
  });

  it('treats unknown programming errors as permanent (visible, not retried forever)', () => {
    expect(classifyThrownError(new Error('boom')).kind).toBe('permanent');
  });
});
