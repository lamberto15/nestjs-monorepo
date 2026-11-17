import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { baseUrl, flag } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * Let SSO connections use http:// and loopback addresses (an IdP on
   * localhost, in development and tests). Never in production: a tenant's
   * administrator could make the API call its own host.
   */
  SSO_ALLOW_LOOPBACK: flag('off'),
  /**
   * The web app's origin, where a browser lands after an SSO sign-in (with
   * `?error=` when it failed). Unset: APP_URL.
   */
  WEB_URL: baseUrl(),
});

export const ssoConfig = registerAs('sso', () => {
  const env = readEnv(schema);
  return { allowLoopback: env.SSO_ALLOW_LOOPBACK, webUrl: env.WEB_URL };
});

export type SsoConfig = ReturnType<typeof ssoConfig>;
