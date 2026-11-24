import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { passkeys } from './account.tables.js';

export type Passkey = typeof passkeys.$inferSelect;

/** The queries of the accounts' passkeys, in the current transaction. */
@Injectable()
export class PasskeysRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The user's passkeys, oldest first. */
  list(userId: string) {
    return this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(asc(passkeys.createdAt), asc(passkeys.id));
  }

  async exists(userId: string) {
    const [found] = await this.db
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .limit(1);
    return found !== undefined;
  }

  /** The user's credential ids and transports, oldest first. */
  credentialsOf(userId: string) {
    return this.db
      .select({
        credentialId: passkeys.credentialId,
        transports: passkeys.transports,
      })
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(asc(passkeys.createdAt));
  }

  async countOf(userId: string) {
    const [{ held }] = await this.db
      .select({ held: count() })
      .from(passkeys)
      .where(eq(passkeys.userId, userId));
    return held;
  }

  /** The new passkey; undefined when its credential id is registered already. */
  async insert(values: typeof passkeys.$inferInsert) {
    const [inserted] = await this.db
      .insert(passkeys)
      .values(values)
      .onConflictDoNothing({ target: passkeys.credentialId })
      .returning();
    return inserted;
  }

  /** The renamed passkey; undefined when it isn't the user's. */
  async rename(userId: string, id: string, name: string) {
    const [row] = await this.db
      .update(passkeys)
      .set({ name })
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
      .returning();
    return row;
  }

  async findOwn(userId: string, id: string) {
    const [found] = await this.db
      .select({ id: passkeys.id, name: passkeys.name })
      .from(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)));
    return found;
  }

  /** False when it was removed meanwhile. */
  async delete(id: string) {
    const deleted = await this.db
      .delete(passkeys)
      .where(eq(passkeys.id, id))
      .returning({ id: passkeys.id });
    return deleted.length > 0;
  }

  async findByCredentialId(credentialId: string) {
    const [row] = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, credentialId));
    return row;
  }

  /**
   * Records an assertion's counter and last use, only forwards (a
   * compare-and-set): false when another assertion recorded a counter as
   * high meanwhile, or the passkey was removed. A synced passkey keeps 0.
   */
  async recordUse(id: string, newCounter: number, backedUp: boolean) {
    const [recorded] = await this.db
      .update(passkeys)
      .set({ counter: newCounter, backedUp, lastUsedAt: new Date() })
      .where(
        and(
          eq(passkeys.id, id),
          newCounter === 0
            ? eq(passkeys.counter, 0)
            : lt(passkeys.counter, newCounter),
        ),
      )
      .returning({ id: passkeys.id });
    return recorded !== undefined;
  }
}
