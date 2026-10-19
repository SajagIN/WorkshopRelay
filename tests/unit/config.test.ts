import { describe, expect, it } from 'vitest';
import { parseConfig, ConfigError } from '../../src/shared/config';

const env = {
  DATABASE_URL: 'postgresql://localhost:5432/x',
} as NodeJS.ProcessEnv;

describe('parseConfig', () => {
  it('applies documented defaults', () => {
    const config = parseConfig(env);
    expect(config.apiPort).toBe(3000);
    expect(config.mockPort).toBe(4100);
    expect(config.workerConcurrency).toBe(5);
    expect(config.workerLeaseMs).toBe(15_000);
    expect(config.notificationTimeoutMs).toBe(3_000);
    expect(config.retryBaseMs).toBe(1_000);
    expect(config.retryCapMs).toBe(60_000);
    expect(config.memberTokens.length).toBeGreaterThan(0);
  });

  it('parses member token pairs', () => {
    const config = parseConfig({
      ...env,
      MEMBER_TOKENS: 'alice:tok-a,bob:tok-b',
    } as NodeJS.ProcessEnv);
    expect(config.memberTokens).toEqual([
      { label: 'alice', token: 'tok-a' },
      { label: 'bob', token: 'tok-b' },
    ]);
  });

  it('rejects malformed member tokens', () => {
    expect(() =>
      parseConfig({ ...env, MEMBER_TOKENS: 'alice-no-token' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('rejects duplicate tokens', () => {
    expect(() =>
      parseConfig({ ...env, MEMBER_TOKENS: 'alice:same,bob:same' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig({ ...env, ORGANIZER_TOKEN: 'same', MEMBER_TOKENS: 'alice:same' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
  });

  it('parses booleans from strings', () => {
    expect(parseConfig({ ...env, ENABLE_DEMO_FAULTS: 'false' } as NodeJS.ProcessEnv).enableDemoFaults).toBe(false);
    expect(parseConfig({ ...env, ENABLE_DEMO_FAULTS: '1' } as NodeJS.ProcessEnv).enableDemoFaults).toBe(true);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => parseConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});
