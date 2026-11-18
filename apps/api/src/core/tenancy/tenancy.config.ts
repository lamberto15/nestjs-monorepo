import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { choice, flag } from '../config/env.helpers.js';
import { readEnv } from '../config/env.js';

export const schema = z.object({
  /**
   * `multi`: many tenants. `single`: one, made at the first start, and no
   * other can be made. The wall and every `tenant_id` stay in both, so a
   * deployment switches by this variable alone, with no data migration.
   */
  TENANCY: choice(['multi', 'single'], 'multi'),
  /**
   * `on`: a first start (no tenant, no user yet) makes the first tenant
   * (TENANCY=single's one) and the first administrator. The operator CLI
   * sets it `off` for itself: it never makes them, so `tenant:import` can
   * fill a database the app has not started on yet.
   */
  FIRST_START_SEED: flag('on'),
});

export const tenancyConfig = registerAs('tenancy', () => {
  const env = readEnv(schema);
  return { mode: env.TENANCY, seed: env.FIRST_START_SEED };
});
