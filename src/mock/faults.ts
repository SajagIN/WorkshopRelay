/**
 * Deterministic fault controller for the mock notification service (PRD §13).
 *
 * Modes:
 * - always_success        accept every delivery
 * - fail_first_n          fail the first N matching requests with 503, then accept
 * - always_503            always fail matching requests with 503 (transient for workers)
 * - always_400            always fail matching requests with 400 (permanent → NEEDS_ATTENTION)
 * - timeout_before_commit sleep past the client timeout WITHOUT writing a receipt
 * - commit_then_timeout   write the receipt, then sleep past the client timeout
 *                         (models an ambiguous outcome: delivery happened, response lost)
 * - seeded_random         seeded PRNG with `failureRate`, recorded seed for reproducibility
 *
 * A rule may be scoped globally, to one recipient, or to one event. Requests
 * outside the scope are accepted normally.
 */

export type FaultMode =
  | 'always_success'
  | 'fail_first_n'
  | 'always_503'
  | 'always_400'
  | 'timeout_before_commit'
  | 'commit_then_timeout'
  | 'seeded_random';

export const FAULT_MODES: FaultMode[] = [
  'always_success',
  'fail_first_n',
  'always_503',
  'always_400',
  'timeout_before_commit',
  'commit_then_timeout',
  'seeded_random',
];

export interface FaultScope {
  kind: 'global' | 'recipient' | 'event';
  recipientId?: string;
  eventId?: string;
}

export interface FaultRuleInput {
  mode: FaultMode;
  scope: FaultScope;
  failFirstN?: number;
  hangMs?: number;
  failureRate?: number;
  seed?: number;
}

export type FaultDecision =
  | { action: 'accept' }
  | { action: 'fail'; status: number; retryAfterSec: number | null; reason: string }
  | { action: 'hang'; commitFirst: boolean; hangMs: number; reason: string };

export interface FaultState {
  mode: FaultMode;
  scope: FaultScope;
  failFirstN: number | null;
  remainingFailures: number | null;
  hangMs: number | null;
  failureRate: number | null;
  seed: number | null;
  requestCount: number;
  faultsInjected: number;
}

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_HANG_MS = 5_000;

export class FaultController {
  private rule: FaultRuleInput | null = null;
  private remainingFailures = 0;
  private prng: () => number = mulberry32(1);
  private requestCount = 0;
  private faultsInjected = 0;

  setRule(input: FaultRuleInput): FaultState {
    if (input.mode === 'always_success') {
      this.rule = null;
    } else {
      this.rule = { ...input };
    }
    this.remainingFailures = input.failFirstN ?? 0;
    this.prng = mulberry32(input.seed ?? 1);
    this.requestCount = 0;
    this.faultsInjected = 0;
    return this.getState();
  }

  clear(): FaultState {
    this.rule = null;
    this.remainingFailures = 0;
    this.requestCount = 0;
    this.faultsInjected = 0;
    return this.getState();
  }

  getState(): FaultState {
    return {
      mode: this.rule?.mode ?? 'always_success',
      scope: this.rule?.scope ?? { kind: 'global' },
      failFirstN: this.rule?.failFirstN ?? null,
      remainingFailures: this.rule ? this.remainingFailures : null,
      hangMs: this.rule?.hangMs ?? null,
      failureRate: this.rule?.failureRate ?? null,
      seed: this.rule?.seed ?? null,
      requestCount: this.requestCount,
      faultsInjected: this.faultsInjected,
    };
  }

  evaluate(input: { eventId: string; recipientId: string }): FaultDecision {
    this.requestCount += 1;
    const rule = this.rule;
    if (!rule || !this.matches(rule.scope, input)) {
      return { action: 'accept' };
    }

    switch (rule.mode) {
      case 'fail_first_n': {
        if (this.remainingFailures > 0) {
          this.remainingFailures -= 1;
          this.faultsInjected += 1;
          return {
            action: 'fail',
            status: 503,
            retryAfterSec: 1,
            reason: `fail_first_n (${this.remainingFailures} failures left after this one)`,
          };
        }
        return { action: 'accept' };
      }
      case 'always_503': {
        this.faultsInjected += 1;
        return { action: 'fail', status: 503, retryAfterSec: 1, reason: 'always_503' };
      }
      case 'always_400': {
        this.faultsInjected += 1;
        return {
          action: 'fail',
          status: 400,
          retryAfterSec: null,
          reason: 'always_400 (permanent failure for operator-action demos)',
        };
      }
      case 'timeout_before_commit': {
        this.faultsInjected += 1;
        return {
          action: 'hang',
          commitFirst: false,
          hangMs: rule.hangMs ?? DEFAULT_HANG_MS,
          reason: 'timeout_before_commit (no receipt written)',
        };
      }
      case 'commit_then_timeout': {
        this.faultsInjected += 1;
        return {
          action: 'hang',
          commitFirst: true,
          hangMs: rule.hangMs ?? DEFAULT_HANG_MS,
          reason: 'commit_then_timeout (receipt written, response delayed)',
        };
      }
      case 'seeded_random': {
        const roll = this.prng();
        const rate = rule.failureRate ?? 0.3;
        if (roll < rate) {
          this.faultsInjected += 1;
          return {
            action: 'fail',
            status: 503,
            retryAfterSec: 1,
            reason: `seeded_random roll=${roll.toFixed(4)} < rate=${rate}`,
          };
        }
        return { action: 'accept' };
      }
      case 'always_success':
      default:
        return { action: 'accept' };
    }
  }

  private matches(scope: FaultScope, input: { eventId: string; recipientId: string }): boolean {
    if (scope.kind === 'global') return true;
    if (scope.kind === 'recipient') return scope.recipientId === input.recipientId;
    return scope.eventId === input.eventId;
  }
}
