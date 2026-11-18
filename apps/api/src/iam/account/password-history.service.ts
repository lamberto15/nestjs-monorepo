import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PasswordHasher } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { AuthPolicy } from '../auth/auth-policy.js';
import { users } from '../auth/auth.tables.js';
import { accountConfig } from './account.config.js';
import { passwordHistory } from './account.tables.js';
import { PasswordHashLimiter } from './password-hashing.js';

/**
 * PASSWORD_HISTORY (or the account's tenants' `passwordHistory` policy,
 * the stricter): a new password may not repeat one of the account's last
 * N (the current one counts), 0 (the default) off.
 *
 * Only hashes are kept, from the account's own hasher, and only while the
 * history is on: with N = 0 a replaced hash is dropped with the rest of
 * the account's history, so turning it off leaves nothing behind at the
 * next change.
 *
 * Custom code: @nestjs/authentication has no password history.
 */
@Injectable()
export class PasswordHistoryService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly limiter: PasswordHashLimiter,
    @Inject(accountConfig.KEY)
    private readonly config: ConfigType<typeof accountConfig>,
    private readonly policy: AuthPolicy,
  ) {}

  /** The deployment's PASSWORD_HISTORY or the account's tenants' choice (AuthPolicy), the stricter. */
  private async count(userId: string) {
    return Math.max(
      this.config.passwordHistory,
      await this.policy.passwordHistory({ userId }),
    );
  }

  /**
   * A 422 `password_reused` (on the field `path`) when the password is the
   * account's current one or one of the previous N - 1. Each comparison is a
   * scrypt verification; they run in one hashing slot, one after the other
   * (an N-wide burst per request would starve the sign-ins). Off, or an
   * account without a password: no hashing.
   */
  async assertNotReused(userId: string, password: string, path: string) {
    const count = await this.count(userId);
    if (count === 0) {
      return;
    }
    const [current] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));
    const previous = await this.db
      .select({ passwordHash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id))
      .limit(Math.max(0, count - 1));
    const hashes = [
      current?.passwordHash,
      ...previous.map((p) => p.passwordHash),
    ].filter((hash): hash is string => !!hash);
    if (hashes.length === 0) {
      return;
    }
    const reused = await this.limiter.run(async () => {
      for (const hash of hashes) {
        if (await this.hasher.verify(password, hash)) {
          return true;
        }
      }
      return false;
    });
    if (reused) {
      const message = t('account.passwordReused');
      throw new UnprocessableEntityException({
        code: 'password_reused',
        message,
        history: count,
        errors: [{ path, message }],
      });
    }
  }

  /**
   * In the caller's transaction, before the password changes: keeps the hash
   * being replaced (the account's current one) and prunes the history to the
   * N - 1 newest. Off (N = 0, or 1: only the current password counts):
   * keeps nothing and drops what was kept.
   */
  async replaced(userId: string) {
    const keep = Math.max(0, (await this.count(userId)) - 1);
    if (keep === 0) {
      await this.db
        .delete(passwordHistory)
        .where(eq(passwordHistory.userId, userId));
      return;
    }
    const [current] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));
    if (current?.passwordHash) {
      await this.db
        .insert(passwordHistory)
        .values({ userId, passwordHash: current.passwordHash });
    }
    const kept = await this.db
      .select({ id: passwordHistory.id })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(desc(passwordHistory.createdAt), desc(passwordHistory.id));
    const stale = kept.slice(keep).map((row) => row.id);
    if (stale.length > 0) {
      await this.db
        .delete(passwordHistory)
        .where(inArray(passwordHistory.id, stale));
    }
  }
}
