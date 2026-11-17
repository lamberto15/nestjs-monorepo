import { readEnv } from '../config/env.js';
import { schema, throttlingConfig } from './throttling.config.js';

describe('throttling config', () => {
  const load = (env: Record<string, string>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      return throttlingConfig();
    } finally {
      process.env = saved;
    }
  };

  it('defaults to Redis and a multiplier of 1', () => {
    expect(readEnv(schema, {})).toMatchObject({
      RATE_LIMIT_STORE: 'redis',
      RATE_LIMIT_MULTIPLIER: 1,
    });
  });

  it('refuses a multiplier above 1 in production unless APP_ENV=loadtest', () => {
    const raised = { RATE_LIMIT_MULTIPLIER: '2', NODE_ENV: 'production' };
    expect(() => load({ ...raised, APP_ENV: '' })).toThrow(/APP_ENV=loadtest/);
    expect(load({ ...raised, APP_ENV: 'loadtest' }).multiplier).toBe(2);
  });
});
