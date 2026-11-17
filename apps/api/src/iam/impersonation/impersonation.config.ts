import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * How long an administrator may act as another user (IMPERSONATION=on):
   * the impersonation session ends then, whatever its activity.
   */
  IMPERSONATION_TTL_MINUTES: integer(60, { min: 1, max: 480 }),
});

export const impersonationConfig = registerAs('impersonation', () => {
  const env = readEnv(schema);
  return { ttlMinutes: env.IMPERSONATION_TTL_MINUTES };
});
