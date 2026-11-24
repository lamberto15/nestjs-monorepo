import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * The runs of occurrences more than this many days past are forgotten
   * every night. Their row only keeps an occurrence from being created twice, and
   * a schedule never comes back to a past one (it resumes after now).
   */
  RECURRENCE_RUN_RETENTION_DAYS: integer(90, { min: 1 }),
});

export const recurrenceConfig = registerAs('recurrence', () => {
  const env = readEnv(schema);
  return { runRetentionDays: env.RECURRENCE_RUN_RETENTION_DAYS };
});
