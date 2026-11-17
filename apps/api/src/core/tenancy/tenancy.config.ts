import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { choice } from '../config/env.helpers.js';
import { readEnv } from '../config/env.js';

export const schema = z.object({
  /**
   * `multi`: many tenants. `single`: one, made at the first start, and no
   * other can be made. The wall and every `tenant_id` stay in both, so a
   * deployment switches by this variable alone, with no data migration.
   */
  TENANCY: choice(['multi', 'single'], 'multi'),
});

export const tenancyConfig = registerAs('tenancy', () => {
  const env = readEnv(schema);
  return { mode: env.TENANCY };
});
