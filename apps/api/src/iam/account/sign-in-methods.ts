import { ConflictException } from '@nestjs/common';
import { t } from '@nestjs/i18n';

/**
 * Refuses to remove a way to sign in when it is the account's last one
 * (409 `last_sign_in_method`): a provider, a passkey. Give it the count
 * taken in the removal's transaction, before the delete, under the
 * account's row lock (`AccountRepository.signInMethods()`).
 */
export function assertNotLastSignInMethod(methods: { total: number }) {
  if (methods.total <= 1) {
    throw new ConflictException({
      code: 'last_sign_in_method',
      message: t('account.lastSignInMethod'),
    });
  }
}
