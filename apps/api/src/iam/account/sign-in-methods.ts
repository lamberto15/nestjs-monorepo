import { ConflictException } from '@nestjs/common';
import { t } from '@nestjs/i18n';
import { count, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { users } from '../auth/auth.tables.js';
import { passkeys, userIdentities } from './account.tables.js';

/**
 * How many ways `userId` has to sign in, counted in `tx` with the account
 * row locked (`FOR UPDATE`): the password, each linked provider, each
 * passkey. Two removals at once then run one after the other, so neither
 * sees "one left" twice. A magic link isn't counted:
 * it needs nothing on the account and works for everyone.
 */
export async function countSignInMethods(tx: Database, userId: string) {
  const [account] = await tx
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  const [[{ identities }], [{ credentials }]] = await Promise.all([
    tx
      .select({ identities: count() })
      .from(userIdentities)
      .where(eq(userIdentities.userId, userId)),
    tx
      .select({ credentials: count() })
      .from(passkeys)
      .where(eq(passkeys.userId, userId)),
  ]);
  const password = account?.passwordHash ? 1 : 0;
  return {
    password,
    identities,
    passkeys: credentials,
    total: password + identities + credentials,
  };
}

/**
 * Refuses to remove a way to sign in when it is the account's last one
 * (409 `last_sign_in_method`): a provider, a passkey. Call it in the
 * removal's transaction, before the delete.
 */
export async function assertNotLastSignInMethod(tx: Database, userId: string) {
  const methods = await countSignInMethods(tx, userId);
  if (methods.total <= 1) {
    throw new ConflictException({
      code: 'last_sign_in_method',
      message: t('account.lastSignInMethod'),
    });
  }
}
