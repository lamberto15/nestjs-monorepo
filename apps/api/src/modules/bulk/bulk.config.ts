import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** Most ids a bulk run answers in the request itself; more, and every filter selection, is a background job. */
  BULK_SYNC_LIMIT: integer(100, { min: 1, max: 500 }),
});

export const bulkConfig = registerAs('bulk', () => {
  const env = readEnv(schema);
  return { syncLimit: env.BULK_SYNC_LIMIT };
});
