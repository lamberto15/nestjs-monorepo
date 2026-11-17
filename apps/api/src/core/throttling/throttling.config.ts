import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { choice, integer, optional } from '../config/env.helpers.js';

export const schema = z.object({
  /** `redis` counts rate limits in Redis, shared by every instance; `memory` per instance (one instance, or tests). */
  RATE_LIMIT_STORE: choice(['redis', 'memory'], 'redis'),
  /**
   * Multiplies every rate limit (the global 600 a minute and each route's
   * `@Throttle()`). For the load test's stack only, whose requests all come
   * from one address: limits are raised there, never turned off. Keep it 1
   * everywhere else: with NODE_ENV=production, above 1 stops the app unless
   * APP_ENV=loadtest.
   */
  RATE_LIMIT_MULTIPLIER: integer(1, { min: 1, max: 100_000 }),
  NODE_ENV: optional().describe(
    '`production` in a deployment: RATE_LIMIT_MULTIPLIER above 1 is then refused unless APP_ENV=loadtest.',
  ),
  APP_ENV: optional().describe(
    "`loadtest` names the load test's throwaway stack, the only production deployment allowed RATE_LIMIT_MULTIPLIER above 1.",
  ),
});

export const throttlingConfig = registerAs('throttling', () => {
  const env = readEnv(schema);
  if (
    env.RATE_LIMIT_MULTIPLIER > 1 &&
    env.NODE_ENV === 'production' &&
    env.APP_ENV !== 'loadtest'
  ) {
    throw new Error(
      'Invalid environment:\nRATE_LIMIT_MULTIPLIER: above 1 only for the load test: with NODE_ENV=production it needs APP_ENV=loadtest',
    );
  }
  return {
    store: env.RATE_LIMIT_STORE,
    multiplier: env.RATE_LIMIT_MULTIPLIER,
  };
});
