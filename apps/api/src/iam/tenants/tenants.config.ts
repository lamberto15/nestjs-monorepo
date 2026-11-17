import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { flag, integer, list } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * Self sign-up (`POST /v1/auth/sign-up`): anyone may make an account,
   * which signs in once its address is proved. Off: only invitations add
   * people.
   */
  AUTH_SIGN_UP: flag('off'),
  /**
   * With TENANCY=multi and AUTH_SIGN_UP=on, a sign-up makes its own tenant
   * and is its first administrator. Ignored (with a warning) otherwise.
   */
  TENANT_SIGN_UP: flag('off'),
  /**
   * With TENANCY=single, the seed roles (keys, comma-separated) a sign-up
   * gets in the one tenant; never `administrator`. Empty: none.
   */
  SIGN_UP_ROLES: list(),
  /** Days between an operator's request to delete a tenant and its erase. */
  TENANT_DELETION_GRACE_DAYS: integer(30, { min: 1, max: 365 }),
  /**
   * Tenants' own domains (`/v1/branding/domains`), proved by a DNS TXT
   * record. Off: the routes answer 404 and no host names a tenant.
   */
  CUSTOM_DOMAINS: flag('off'),
});

export const tenantsConfig = registerAs('tenants', () => {
  const env = readEnv(schema);
  return {
    signUp: env.AUTH_SIGN_UP,
    tenantSignUp: env.TENANT_SIGN_UP,
    signUpRoles: env.SIGN_UP_ROLES,
    deletionGraceDays: env.TENANT_DELETION_GRACE_DAYS,
    customDomains: env.CUSTOM_DOMAINS,
  };
});
