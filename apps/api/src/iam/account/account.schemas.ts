import { ForbiddenException } from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { z } from 'zod';
import { redirectPath } from '../../core/http/redirect-path.js';
import {
  codeChallenge,
  codeVerifier,
  nativeLoginQuery,
} from './native-redirect.js';
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

export const oidcIdentitySchema = z.object({
  provider: z.string(),
  email: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * The login route's query. A query parameter sent twice
 * (`?redirectTo=/a&redirectTo=//evil`) reaches the handler as an array, and
 * a string method on it throws (a 500, CodeQL
 * js/type-confusion-through-parameter-tampering): the schema makes each one a
 * string or, when it isn't one, absent (`catch`), since the browser is
 * navigating here and a problem response would be its landing page. So is
 * a `redirectTo` that isn't a path of the web app (`isSafeRedirectPath`):
 * dropped, never stored with the login, and the browser lands on the web
 * app's root.
 */
export const oidcLoginQuerySchema = z.object({
  redirectTo: redirectPath
    .optional()
    .catch(undefined)
    .describe(
      'A path of the web app to land on (one leading `/`, printable ASCII, no `\\`); anything else is ignored.',
    ),
  link: z
    .string()
    .optional()
    .catch(undefined)
    .describe('`true`: connect the provider to the signed-in account.'),
  reauthenticate: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      '`true`: re-authenticate the signed-in user through the provider (step-up), with a fresh login there.',
    ),
  ...nativeLoginQuery,
  ticket: z
    .string()
    .max(128)
    .optional()
    .catch(undefined)
    .describe(
      "A signed-in app's link or step-up: the `url` of POST /auth/identities/{provider}/native carries it.",
    ),
});

export const nativeTicketSchema = z.object({
  purpose: z
    .enum(['link', 'reauthenticate'])
    .describe(
      "`link`: connect the provider to your account (wants a recent sign-in, as the browser's). `reauthenticate`: step up through a provider already connected.",
    ),
  redirectUri: z
    .string()
    .max(2048)
    .describe(
      'One of NATIVE_REDIRECT_URIS: where the browser hands back `?code=` or `?error=`.',
    ),
  codeChallenge,
});

export const nativeCompleteSchema = z.object({
  handoffCode: z
    .string()
    .min(1)
    .max(128)
    .describe("The `code` the ticket's `redirectUri` was handed."),
  codeVerifier: codeVerifier.describe(
    "The PKCE verifier of the ticket's `codeChallenge`.",
  ),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('A step-up with two-factor on: a code from the app.'),
  recoveryCode: z.string().max(64).optional(),
  refreshToken: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      'A step-up: your current refresh token, revoked once the new pair is issued.',
    ),
});

export const nativeCompletedSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('link'), identity: oidcIdentitySchema }),
  z.object({
    purpose: z.literal('reauthenticate'),
    accessToken: z
      .string()
      .describe('A JWT with `auth_time` now: `Authorization: Bearer …`.'),
    refreshToken: z.string().describe('Single use: POST /auth/token/refresh.'),
    expiresIn: z
      .number()
      .int()
      .describe('Seconds until the access token expires.'),
  }),
]);

/**
 * What the provider sends back, and all that `OidcService.finish` reads
 * (`state`; `code`, `error` and `iss` in its client): each a string, so a
 * repeated parameter is a 400, not a 500. Anything else is dropped.
 */
export const oidcCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  iss: z.string().optional(),
});

export const nativeTicketUrlSchema = z.object({
  url: z
    .string()
    .describe(
      'The login route with the ticket: open it in the system browser.',
    ),
});
