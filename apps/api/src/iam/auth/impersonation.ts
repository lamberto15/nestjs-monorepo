import { ForbiddenException } from '@nestjs/common';
import type { MfaState, SessionRecord } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import type { AuthenticationMetadata } from './authentication-method.js';
import type { Principal } from './principal.js';

/** What is the person's own (credentials, their account) can't be changed by an administrator acting as them. */
export function notWhileImpersonating(user: Principal) {
  if (user.kind === 'user' && user.impersonator) {
    throw new ForbiddenException(t('auth.notWhileImpersonating'));
  }
}

/**
 * What an impersonation session records about the administrator behind it.
 * Starting one is the access module's; SessionAuth checks a running one on
 * every request (IMPERSONATION, its end, both memberships).
 */
export interface Impersonation {
  id: string;
  email: string;
  /** Their own session's second factor, restored when they stop. */
  mfa: MfaState | null;
  /**
   * How and when they signed in, restored when they stop. Kept here, not in
   * the session's own keys: an impersonation is nobody's sign-in, and never
   * satisfies step-up (ReauthenticationService).
   */
  authentication?: AuthenticationMetadata;
  startedAt: string;
  endsAt: string;
  /** The tenant it was started in: it never acts in another (docs/tenancy.md). */
  tenantId: string;
}

/**
 * The tenant a session acts in (`metadata.tenantId`): set when it was
 * created (the user's last chosen tenant), changed only by re-issuing the
 * session; undefined or null: none.
 */
export const sessionTenant = (session: SessionRecord | undefined) => {
  const tenantId = session?.metadata?.tenantId;
  return typeof tenantId === 'string' ? tenantId : null;
};

/** The impersonation a session carries, if it is one. */
export const impersonationOf = (session: SessionRecord | undefined) =>
  session?.metadata?.impersonator as Impersonation | undefined;
