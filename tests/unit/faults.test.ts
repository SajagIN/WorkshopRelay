import { describe, expect, it } from 'vitest';
import { FaultController, mulberry32 } from '../../src/mock/faults';

const evt = (eventId = 'e1', recipientId = 'r1') => ({ eventId, recipientId });

describe('FaultController', () => {
  it('accepts everything in always_success mode', () => {
    const f = new FaultController();
    f.setRule({ mode: 'always_success', scope: { kind: 'global' } });
    expect(f.evaluate(evt()).action).toBe('accept');
    expect(f.evaluate(evt()).action).toBe('accept');
  });

  it('fail_first_n fails exactly N times then accepts', () => {
    const f = new FaultController();
    f.setRule({ mode: 'fail_first_n', scope: { kind: 'global' }, failFirstN: 2 });
    expect(f.evaluate(evt()).action).toBe('fail');
    expect(f.evaluate(evt()).action).toBe('fail');
    expect(f.evaluate(evt()).action).toBe('accept');
    expect(f.evaluate(evt()).action).toBe('accept');
  });

  it('respects recipient scope', () => {
    const f = new FaultController();
    f.setRule({ mode: 'always_503', scope: { kind: 'recipient', recipientId: 'r1' } });
    expect(f.evaluate(evt('e1', 'r1')).action).toBe('fail');
    expect(f.evaluate(evt('e2', 'r2')).action).toBe('accept');
  });

  it('respects event scope', () => {
    const f = new FaultController();
    f.setRule({ mode: 'always_400', scope: { kind: 'event', eventId: 'e1' } });
    expect(f.evaluate(evt('e1')).action).toBe('fail');
    expect(f.evaluate(evt('e2')).action).toBe('accept');
  });

  it('always_400 reports a permanent status code', () => {
    const f = new FaultController();
    f.setRule({ mode: 'always_400', scope: { kind: 'global' } });
    const d = f.evaluate(evt());
    expect(d).toMatchObject({ action: 'fail', status: 400, retryAfterSec: null });
  });

  it('timeout_before_commit hangs without commit; commit_then_timeout commits first', () => {
    const f = new FaultController();
    f.setRule({ mode: 'timeout_before_commit', scope: { kind: 'global' }, hangMs: 1234 });
    expect(f.evaluate(evt())).toMatchObject({ action: 'hang', commitFirst: false, hangMs: 1234 });

    f.setRule({ mode: 'commit_then_timeout', scope: { kind: 'global' }, hangMs: 4321 });
    expect(f.evaluate(evt())).toMatchObject({ action: 'hang', commitFirst: true, hangMs: 4321 });
  });

  it('seeded_random is reproducible for the same seed', () => {
    const decisions = (seed: number) => {
      const f = new FaultController();
      f.setRule({ mode: 'seeded_random', scope: { kind: 'global' }, seed, failureRate: 0.5 });
      return Array.from({ length: 20 }, () => f.evaluate(evt()).action);
    };
    expect(decisions(42)).toEqual(decisions(42));
  });

  it('clear() restores always-success behavior', () => {
    const f = new FaultController();
    f.setRule({ mode: 'always_503', scope: { kind: 'global' } });
    expect(f.evaluate(evt()).action).toBe('fail');
    f.clear();
    expect(f.evaluate(evt()).action).toBe('accept');
    expect(f.getState().mode).toBe('always_success');
  });
});

describe('mulberry32', () => {
  it('produces values in [0, 1) and is deterministic', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 5; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(b());
    }
  });
});
