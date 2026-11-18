import { z } from 'zod';
import {
  PASSWORD_HISTORY_LIMIT,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_LENGTH_LIMIT,
} from '../auth/auth-policy.js';
import {
  SESSION_IDLE_MINUTES_FLOOR,
  SESSION_IDLE_MINUTES_LIMIT,
  SESSION_MAX_HOURS_LIMIT,
} from '../auth/auth.config.js';

const fields = {
  requireMfa: z
    .boolean()
    .describe(
      'Every member must have two-factor sign-in: one without may only set it up after signing in (403 mfa_enrollment_required elsewhere). API clients are unaffected.',
    ),
  passwordMinLength: z
    .number()
    .int()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MIN_LENGTH_LIMIT)
    .nullable()
    .describe(
      `Characters a new password needs (${PASSWORD_MIN_LENGTH} to ${PASSWORD_MIN_LENGTH_LIMIT}); a person in several tenants meets the strictest. null: ${PASSWORD_MIN_LENGTH}.`,
    ),
  passwordHistory: z
    .number()
    .int()
    .min(0)
    .max(PASSWORD_HISTORY_LIMIT)
    .nullable()
    .describe(
      "How many of an account's last passwords can't be used again (0 is off). null: the deployment's PASSWORD_HISTORY alone.",
    ),
  sessionIdleMinutes: z
    .number()
    .int()
    .min(SESSION_IDLE_MINUTES_FLOOR)
    .max(SESSION_IDLE_MINUTES_LIMIT)
    .nullable()
    .describe(
      "Minutes without a request after which a session ends, at most the deployment's SESSION_IDLE_MINUTES. null: the deployment's.",
    ),
  sessionMaxHours: z
    .number()
    .int()
    .min(1)
    .max(SESSION_MAX_HOURS_LIMIT)
    .nullable()
    .describe(
      "Hours after the sign-in when a session, or a token client's refresh-token family, ends however active, at most the deployment's SESSION_MAX_HOURS. null: the deployment's.",
    ),
  allowBreakGlass: z
    .boolean()
    .describe(
      "false: the deployment's operators can never open this tenant with a break-glass grant.",
    ),
};

export const requireMfaSchema = z.object({ requireMfa: fields.requireMfa });

export const authPolicySchema = z.object(fields);

export const updateAuthPolicySchema = z.object(fields).partial().strict();

export type AuthPolicyView = z.infer<typeof authPolicySchema>;
export type AuthPolicyChanges = z.infer<typeof updateAuthPolicySchema>;
