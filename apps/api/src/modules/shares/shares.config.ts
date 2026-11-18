import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';
import { observabilityConfig } from '../../core/observability/observability.config.js';

export const schema = z.object({
  /** The most days a share link may work. */
  SHARE_MAX_DAYS: integer(30, { min: 1, max: 365 }),
});

export const sharesConfig = registerAs('shares', () => {
  const env = readEnv(schema);
  return {
    // SERVICE_NAME (core/observability): the mail with a share's code names it.
    serviceName: observabilityConfig().serviceName,
    maxDays: env.SHARE_MAX_DAYS,
  };
});
