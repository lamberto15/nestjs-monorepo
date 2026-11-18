import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** Revisions older than this many days are deleted every night (03:25 UTC); a record's latest always stays. */
  REVISIONS_RETENTION_DAYS: integer(365, { min: 1 }),
});

export const revisionsConfig = registerAs('revisions', () => {
  const env = readEnv(schema);
  return { retentionDays: env.REVISIONS_RETENTION_DAYS };
});
