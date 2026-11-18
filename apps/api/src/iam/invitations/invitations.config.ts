import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';
import { observabilityConfig } from '../../core/observability/observability.config.js';

export const schema = z.object({
  /** How long an invitation's link works, in hours. */
  INVITATION_TTL_HOURS: integer(7 * 24, { min: 1, max: 30 * 24 }),
});

export const invitationsConfig = registerAs('invitations', () => {
  const env = readEnv(schema);
  return {
    ttlHours: env.INVITATION_TTL_HOURS,
    // SERVICE_NAME is observability's (core): the name the invitation mail gives the service.
    serviceName: observabilityConfig().serviceName,
  };
});
