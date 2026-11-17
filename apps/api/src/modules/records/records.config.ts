import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** Days a record stays in its recycle bin before it is purged (03:45 UTC): a declaration's `recycleBinDays` wins. */
  SOFT_DELETE_RETENTION_DAYS: integer(30, { min: 1 }),
});

export const recordsConfig = registerAs('records', () => {
  const env = readEnv(schema);
  return { recycleBinDays: env.SOFT_DELETE_RETENTION_DAYS };
});
