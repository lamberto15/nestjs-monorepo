import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  flag,
  optional,
  secret,
  withDefault,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * The first administrator's address, made on a deployment's first start
   * (AccessSeeder). The placeholder default asks for a real one at the
   * first sign-in (ADMIN_ONBOARDING).
   */
  ADMIN_EMAIL: withDefault('admin@example.com'),
  /** The first administrator's password. Unset: one is generated and logged once. */
  ADMIN_PASSWORD: secret(optional()),
  /**
   * On: a first administrator on the placeholder address, or with the
   * generated password, must replace it at their first sign-in.
   */
  ADMIN_ONBOARDING: flag('on'),
  /** The name of the first tenant, the operators' (its slug is OPERATOR_TENANT, or made from the name). */
  ADMIN_TENANT_NAME: withDefault('Operators'),
});

export const accessConfig = registerAs('access', () => {
  const env = readEnv(schema);
  return {
    adminEmail: env.ADMIN_EMAIL,
    adminPassword: env.ADMIN_PASSWORD,
    adminOnboarding: env.ADMIN_ONBOARDING,
    adminTenantName: env.ADMIN_TENANT_NAME,
  };
});
