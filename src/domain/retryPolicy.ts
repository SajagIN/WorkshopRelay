/**
 * Retry classification and backoff (PRD §9 "Retry policy").
 *
 * - Transient failures (timeouts, connection errors, 408/429/5xx) are retried
 *   indefinitely with capped exponential backoff and full jitter — jobs are
 *   never discarded merely for exceeding an attempt count.
 * - Clear permanent 4xx failures become NEEDS_ATTENTION (visible operator
 *   intervention) instead of burning retries forever.
 * - Server-provided Retry-After is honored within a bounded window.
 */

export type SendOutcome =
  | { kind: 'success'; httpStatus: number }
  | {
      kind: 'transient';
      httpStatus: number | null;
      error: string;
      retryAfterMs: number | null;
    }
  | { kind: 'permanent'; httpStatus: number | null; error: string };

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  minMs: number;
  /** Injectable RNG (defaults to Math.random) so tests are deterministic. */
  random?: () => number;
  /** Server-provided Retry-After, already converted to milliseconds. */
  retryAfterMs?: number | null;
  /** Upper bound for honoring Retry-After. */
  retryAfterMaxMs: number;
}

/**
 * Full jitter: uniform random delay in [0, min(cap, base * 2^(attempt-1))],
 * clamped to `minMs` to avoid hot loops. attempt is 1-based (the attempt that
 * just failed).
 */
export function computeBackoffMs(attempt: number, opts: BackoffOptions): number {
  const random = opts.random ?? Math.random;
  const exp = Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt - 1));

  if (opts.retryAfterMs != null && opts.retryAfterMs > 0) {
    const bounded = Math.min(Math.max(opts.retryAfterMs, opts.minMs), opts.retryAfterMaxMs);
    return bounded;
  }

  const jittered = Math.floor(random() * exp);
  return Math.max(opts.minMs, jittered);
}

/** HTTP statuses that always count as transient. */
const TRANSIENT_STATUSES = new Set([408, 429]);

export function classifyHttpStatus(httpStatus: number, bodyText?: string): SendOutcome {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { kind: 'success', httpStatus };
  }
  if (TRANSIENT_STATUSES.has(httpStatus) || (httpStatus >= 500 && httpStatus <= 599)) {
    return {
      kind: 'transient',
      httpStatus,
      error: summarizeHttpError(httpStatus, bodyText),
      retryAfterMs: null,
    };
  }
  // Other 4xx (and anything unexpected) is a permanent, visible condition.
  return {
    kind: 'permanent',
    httpStatus,
    error: summarizeHttpError(httpStatus, bodyText),
  };
}

export function classifyThrownError(err: unknown): SendOutcome {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  // AbortError/TimeoutError from AbortSignal.timeout, undici connect errors, DNS
  // failures etc. are all transient delivery problems.
  const transientNames = new Set([
    'AbortError',
    'TimeoutError',
    'FetchError',
    'ConnectError',
    'SocketError',
  ]);
  const transientCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);
  const code = (err as { code?: string } | null)?.code ?? '';
  if (transientNames.has(name) || transientCodes.has(code) || /fetch failed/i.test(message)) {
    return {
      kind: 'transient',
      httpStatus: null,
      error: truncate(`${name || code || 'network'}: ${message}`, 300),
      retryAfterMs: null,
    };
  }
  return {
    kind: 'permanent',
    httpStatus: null,
    error: truncate(`${name || 'error'}: ${message}`, 300),
  };
}

/**
 * Parse a Retry-After header (seconds or HTTP-date) into milliseconds.
 * Returns null when absent/unparseable. Callers bound it via retryAfterMaxMs.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(parseFloat(trimmed) * 1000);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now.getTime());
  }
  return null;
}

function summarizeHttpError(status: number, bodyText?: string): string {
  const body = bodyText ? `: ${truncate(bodyText.replace(/\s+/g, ' '), 200)}` : '';
  return truncate(`HTTP ${status}${body}`, 300);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}
