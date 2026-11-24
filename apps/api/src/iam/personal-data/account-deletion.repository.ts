import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { memberships, users } from '../auth/auth.tables.js';
import { accountDeletions } from './personal-data.tables.js';

export type Deletion = typeof accountDeletions.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The queries of account deletions and of the account they delete, in no
 * tenant (the caller runs there) and the ambient transaction.
 */
@Injectable()
export class AccountDeletionRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The account's deletion neither cancelled nor completed. */
  async findPending(userId: string): Promise<Deletion | undefined> {
    const [row] = await this.db
      .select()
      .from(accountDeletions)
      .where(
        and(
          eq(accountDeletions.userId, userId),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.completedAt),
        ),
      );
    return row;
  }

  /** The deletions due at `now`, neither cancelled nor completed. */
  due(now: Date) {
    return this.db
      .select()
      .from(accountDeletions)
      .where(
        and(
          lte(accountDeletions.scheduledFor, now),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.completedAt),
        ),
      );
  }

  async insert(values: { userId: string; scheduledFor: Date }) {
    const [created] = await this.db
      .insert(accountDeletions)
      .values(values)
      .returning();
    return created!;
  }

  /** Cancels the request if it is pending and not started: true when it did. */
  async cancelPending(id: string, userId: string) {
    const rows = await this.db
      .update(accountDeletions)
      .set({ cancelledAt: new Date() })
      .where(
        and(
          eq(accountDeletions.id, id),
          eq(accountDeletions.userId, userId),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.startedAt),
          isNull(accountDeletions.completedAt),
        ),
      )
      .returning({ id: accountDeletions.id });
    return rows.length > 0;
  }

  /** Marks the request started (once) unless cancelled or completed: true when it is. */
  async claim(id: string) {
    const claimed = await this.db
      .update(accountDeletions)
      .set({ startedAt: sql`coalesce(${accountDeletions.startedAt}, now())` })
      .where(
        and(
          eq(accountDeletions.id, id),
          isNull(accountDeletions.cancelledAt),
          isNull(accountDeletions.completedAt),
        ),
      )
      .returning({ id: accountDeletions.id });
    return claimed.length > 0;
  }

  async complete(id: string, completedAt: Date) {
    await this.db
      .update(accountDeletions)
      .set({ completedAt })
      .where(eq(accountDeletions.id, id));
  }

  /** The account's row, locked until the transaction ends (nothing for an id that isn't one). */
  async lockAccount(userId: string) {
    if (!UUID.test(userId)) {
      return;
    }
    await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
  }

  async findAccount(userId: string) {
    const [account] = await this.db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.id, userId));
    return account;
  }

  /** Replaces what identifies the account, and ends its memberships (their roles and units cascade). */
  async anonymise(userId: string, name: string) {
    await this.db
      .update(users)
      .set({
        email: `deleted-${userId}@anonymized.invalid`,
        name,
        passwordHash: null,
        emailVerified: false,
        locale: null,
        timezone: null,
        active: false,
        onboardingEmail: false,
        onboardingPassword: false,
      })
      .where(eq(users.id, userId));
    await this.db.delete(memberships).where(eq(memberships.userId, userId));
  }
}
