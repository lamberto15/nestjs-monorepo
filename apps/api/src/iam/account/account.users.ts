import { createHash } from 'node:crypto';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { users } from '../auth/auth.tables.js';
import { isPlaceholderEmail } from '../auth/onboarding.js';
import { normalizeEmail } from '../auth/users.repository.js';
import { emailTokens } from './account.tables.js';

/** The package stores a link by its token's SHA-256, base64url (its `sha256()`). */
const linkId = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/**
 * The queries of `users` the account's flows need beyond UsersRepository
 * (iam/auth): a new password, a proved address, a link's account read
 * without spending the link. Queries join the current transaction.
 */
@Injectable()
export class AccountUsers {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The whole row: a mail's recipient (address, name, language, time zone). */
  async find(id: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  /** An account by address, active or not (the magic link mails only an existing one). */
  async findByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    return row;
  }

  /**
   * A new password (a change, a reset link). It also ends the first
   * administrator's password onboarding: the generated password is replaced.
   */
  async replacePassword(id: string, passwordHash: string) {
    await this.db
      .update(users)
      .set({ passwordHash, onboardingPassword: false })
      .where(eq(users.id, id));
  }

  /** Only while `email` is still the user's address: a link sent to an old one verifies nothing. */
  async markEmailVerified(id: string, email: string): Promise<boolean> {
    const rows = await this.db
      .update(users)
      // A real address proved ends the first administrator's email onboarding.
      .set({
        emailVerified: true,
        ...(!isPlaceholderEmail(email) && { onboardingEmail: false }),
      })
      .where(and(eq(users.id, id), eq(users.email, normalizeEmail(email))))
      .returning({ id: users.id });
    return rows.length === 1;
  }

  /**
   * The account a verification link (unspent, unexpired) is for, with what
   * verifying it requires: read without spending the link.
   */
  async pendingVerification(token: string) {
    const [row] = await this.db
      .select({
        userId: users.id,
        passwordHash: users.passwordHash,
        emailVerified: users.emailVerified,
      })
      .from(emailTokens)
      .innerJoin(users, eq(sql`${users.id}::text`, emailTokens.userId))
      .where(
        and(
          eq(emailTokens.id, linkId(token)),
          eq(emailTokens.purpose, 'email-verification'),
          gt(emailTokens.expiresAt, new Date()),
        ),
      );
    return row;
  }

  /** The account a password reset link (unspent, unexpired) is for, without spending it. */
  async pendingReset(token: string) {
    const [row] = await this.db
      .select({ userId: emailTokens.userId })
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.id, linkId(token)),
          eq(emailTokens.purpose, 'password-reset'),
          gt(emailTokens.expiresAt, new Date()),
        ),
      );
    return row?.userId;
  }

  /** Whether the user was sent a verification link after `since` (a sign-up, a resend). */
  async verificationLinkSentSince(userId: string, since: Date) {
    const [row] = await this.db
      .select({ id: emailTokens.id })
      .from(emailTokens)
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, 'email-verification'),
          gt(emailTokens.createdAt, since),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
