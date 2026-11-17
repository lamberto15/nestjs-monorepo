import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  baseUrl,
  integer,
  withDefault,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** How long an invitation's link works, in hours. */
  INVITATION_TTL_HOURS: integer(7 * 24, { min: 1, max: 30 * 24 }),
  /**
   * The web app's base URL: the invitation link opens its
   * `/accept-invitation` page. Unset: APP_URL.
   */
  WEB_URL: baseUrl(),
  /** The service's name, as the invitation mail calls it. */
  SERVICE_NAME: withDefault('api'),
});

export const invitationsConfig = registerAs('invitations', () => {
  const env = readEnv(schema);
  return {
    ttlHours: env.INVITATION_TTL_HOURS,
    webUrl: env.WEB_URL,
    serviceName: env.SERVICE_NAME,
  };
});
