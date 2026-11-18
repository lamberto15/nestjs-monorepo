import { ForbiddenException } from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { z } from 'zod';
import { redirectPath } from '../../core/http/redirect-path.js';
import type { UserPrincipal } from '../auth/principal.js';

/** Passwords: 12 to 128 characters (NIST 800-63B: length over composition rules). */
export const newPassword = z.string().min(12).max(128);
/** An email address; spaces around it (a paste) are dropped first. */
export const email = z
  .string()
  .trim()
  .pipe(z.email())
  .meta({ example: 'ada@example.com' });
export const token = z.string().min(1).max(512);
/** Where to send the browser after a sign-in by link or provider: a path of the web app. */
export const redirectTo = redirectPath.optional();
/** An IANA time zone (`Europe/Berlin`), as Intl knows it. */
export const timezone = z
  .string()
  .max(64)
  .refine(isTimeZone, 'must be an IANA time zone, e.g. Europe/Berlin')
  .meta({ example: 'Europe/Berlin' });
/** A BCP 47 language tag; the route checks it against LOCALES. */
export const locale = z.string().min(2).max(35).meta({ example: 'de' });

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A code from the authenticator app. */
export const totpCode = z.string().regex(/^\d{6}$/);

export const signedInSchema = z.object({
  signedIn: z.boolean(),
  mfaRequired: z
    .boolean()
    .describe(
      'true: send a code to POST /auth/mfa/verify to finish signing in.',
    ),
  redirectTo: z.string().optional(),
});

export const acceptedSchema = z.object({ accepted: z.literal(true) });

/**
 * Refuses a way in (a second factor, a linked provider, a passkey) for an
 * account whose owner never proved the address (403 `email_unverified`):
 * whoever holds such an account's session may not be its owner, and must
 * not bind their own authenticator or provider to it.
 */
export function verifiedEmailOnly(user: UserPrincipal) {
  if (!user.emailVerified) {
    throw new ForbiddenException({
      code: 'email_unverified',
      message: t('auth.emailUnverified'),
    });
  }
}

/** Credentials can't be changed by an administrator acting as the user (iam/auth's rule). */
export { notWhileImpersonating } from '../auth/impersonation.js';
