import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { flag, integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * `off` stops counting API clients' requests: no usage routes, no
   * roll-up, and daily client quotas are stored but not enforced.
   */
  USAGE: flag('on'),
  /** Rolled-up usage rows older than this many days are deleted every night. */
  USAGE_RETENTION_DAYS: integer(400, { min: 1 }),
});

export const usageConfig = registerAs('usage', () => {
  const env = readEnv(schema);
  return { enabled: env.USAGE, retentionDays: env.USAGE_RETENTION_DAYS };
});
