import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * Runs in the run log older than this many days are deleted every night:
   * the log is for finding out why a rule did what it did, recently, and
   * the loop guard reads only the last hour.
   */
  AUTOMATIONS_RUN_RETENTION_DAYS: integer(90, { min: 1 }),
});

export const automationsConfig = registerAs('automations', () => {
  const env = readEnv(schema);
  return { runRetentionDays: env.AUTOMATIONS_RUN_RETENTION_DAYS };
});
