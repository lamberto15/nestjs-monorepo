import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  flag,
  integer,
  optional,
  secret,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

/** The shortest idle timeout: the web app warns two minutes before it. */
export const SESSION_IDLE_MINUTES_FLOOR = 5;
/** The longest idle timeout (a week) and absolute lifetime (30 days) a deployment may set. */
export const SESSION_IDLE_MINUTES_LIMIT = 10_080;
export const SESSION_MAX_HOURS_LIMIT = 720;

export const schema = z.object({
  /**
   * A browser session ends after this many minutes without a request. The
   * deployment's ceiling: a tenant's own limit may only shorten it.
   */
  SESSION_IDLE_MINUTES: integer(120, {
    min: SESSION_IDLE_MINUTES_FLOOR,
    max: SESSION_IDLE_MINUTES_LIMIT,
  }),
  /**
   * A browser session ends this many hours after its sign-in, however
   * active. The deployment's ceiling: a tenant's own limit may only shorten
   * it, and then also its token clients' refresh-token families.
   */
  SESSION_MAX_HOURS: integer(12, { min: 1, max: SESSION_MAX_HOURS_LIMIT }),
  /** Off only for plain HTTP on a host other than localhost; the cookie is then named `sid`, not `__Host-sid`. */
  SESSION_COOKIE_SECURE: flag('on'),
  /** Signs the access tokens of mobile apps and CLIs (HS256, 32+ bytes). Unset: one is made once and kept in the database (core/secrets). */
  JWT_SECRET: secret(optional()),
  /**
   * API clients (keys `sk_…`). Off: a key no longer authenticates (401) and
   * the routes that manage clients answer 404 `feature_off`; users are
   * unaffected, and keys work again once it is on.
   */
  API_CLIENTS: flag('on'),
  /**
   * Support impersonation (an administrator acts as a user). Off: a session
   * that impersonates ends at its next request, and the routes that start
   * one answer 404 `feature_off`. A privileged tool: opt in.
   */
  IMPERSONATION: flag('off'),
  /**
   * How long a sign-in counts as recent for the sensitive routes
   * (`@RecentAuthentication()`): older, they answer 403
   * `reauthentication_required`.
   */
  REAUTHENTICATION_MAX_AGE_MINUTES: integer(10, { min: 1, max: 1440 }),
  /**
   * The slug of the operators' tenant: its members may use the routes that
   * reach past one tenant (`@OperatorOnly()`), given their permission.
   * Unset: nobody may (with TENANCY=single the one tenant is the
   * operators').
   */
  OPERATOR_TENANT: optional(),
});

export const authConfig = registerAs('auth', () => {
  const env = readEnv(schema);
  if (env.JWT_SECRET !== undefined && Buffer.byteLength(env.JWT_SECRET) < 32) {
    throw new Error(
      'Invalid environment:\nJWT_SECRET: at least 32 bytes (openssl rand -base64 32)',
    );
  }
  return {
    sessionIdleMinutes: env.SESSION_IDLE_MINUTES,
    sessionMaxHours: env.SESSION_MAX_HOURS,
    sessionCookieSecure: env.SESSION_COOKIE_SECURE,
    jwtSecret: env.JWT_SECRET,
    apiClients: env.API_CLIENTS,
    impersonation: env.IMPERSONATION,
    reauthenticationMaxAgeMinutes: env.REAUTHENTICATION_MAX_AGE_MINUTES,
    operatorTenant: env.OPERATOR_TENANT,
  };
});

export type AuthConfig = ReturnType<typeof authConfig>;
