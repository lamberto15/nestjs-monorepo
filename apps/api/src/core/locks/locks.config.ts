import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { flag } from '../config/env.helpers.js';

export const schema = z.object({
  /** Scheduled jobs (@Cron, @Interval, @Timeout): off for tests and for an instance that must not run them. */
  SCHEDULER: flag('on'),
});

export const locksConfig = registerAs('locks', () => {
  const env = readEnv(schema);
  return { scheduler: env.SCHEDULER };
});
