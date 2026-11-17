import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';

const schema = z.object({
  /** PostgreSQL 18 or later. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Connections the process may hold. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
});

export const databaseConfig = registerAs('database', () => {
  const env = readEnv(schema);
  return { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX };
});
