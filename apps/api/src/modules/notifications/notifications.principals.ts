import { ForbiddenException } from '@nestjs/common';
import { t } from '@nestjs/i18n';
import type { Principal, UserPrincipal } from '../../iam/auth/principal.js';

/**
 * Refuses an administrator acting as the person (impersonation): what is the
 * person's own (marking read, removing, preferences) is not changed from
 * outside. Throws a 403.
 */
export function notWhileImpersonating(principal: Principal) {
  if (principal.kind === 'user' && principal.impersonator) {
    throw new ForbiddenException({
      code: 'impersonating',
      message: t('auth.notWhileImpersonating'),
    });
  }
}

/** The signed-in person: devices and quiet hours are theirs alone (not an API client's, not while an administrator acts as them). */
export function person(principal: Principal): UserPrincipal {
  if (principal.kind !== 'user') {
    throw new ForbiddenException('This belongs to people, not API clients.');
  }
  notWhileImpersonating(principal);
  return principal;
}
