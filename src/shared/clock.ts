/**
 * Injectable clock so tests can control time without long sleeps.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(date: Date): void;
}

export function createFakeClock(start: Date = new Date('2026-11-01T00:00:00Z')): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
    set(date: Date) {
      current = date.getTime();
    },
  };
}
