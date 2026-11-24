import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { users } from '../../iam/auth/auth.tables.js';
import { MAIL_SUPPRESSION_LIST } from './deliverability.lists.js';
import { mailEvents, mailSuppressions } from './deliverability.tables.js';

type NewSuppression = typeof mailSuppressions.$inferInsert;
type NewMailEvent = typeof mailEvents.$inferInsert;

/**
 * The suppression list's and the mail events' queries. Both tables are
 * global (every tenant's mail together); the transaction is the caller's.
 */
@Injectable()
export class DeliverabilityRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** How many addresses are suppressed, by reason. */
  async suppressedByReason() {
    return this.db
      .select({ reason: mailSuppressions.reason, value: count() })
      .from(mailSuppressions)
      .where(isNotNull(mailSuppressions.suppressedAt))
      .groupBy(mailSuppressions.reason);
  }

  /** A page of entries (one row more than the limit), and the total. */
  async list(query: ListQuery) {
    const where = MAIL_SUPPRESSION_LIST.where(query);
    return Promise.all([
      this.db
        .select()
        .from(mailSuppressions)
        .where(and(where, afterCursor(mailSuppressions.id, query)))
        .orderBy(...pageOrder(mailSuppressions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, mailSuppressions, where, query),
    ]);
  }

  /** An entry, locked for the change when `lock`. */
  async findById(id: string, { lock = false } = {}) {
    const query = this.db
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.id, id));
    const [row] = await (lock ? query.for('update') : query);
    return row;
  }

  /** The address's entry, locked for the change. */
  async lockOfAddress(address: string) {
    const [row] = await this.db
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.address, address))
      .for('update');
    return row;
  }

  /** The suppressed entries of these addresses. */
  async suppressedOf(addresses: string[]) {
    return this.db
      .select()
      .from(mailSuppressions)
      .where(
        and(
          inArray(mailSuppressions.address, addresses),
          isNotNull(mailSuppressions.suppressedAt),
        ),
      );
  }

  /** Expired soft-bounce suppressions go back to watched only. */
  async unsuppress(ids: string[]) {
    await this.db
      .update(mailSuppressions)
      .set({ suppressedAt: null, softBounces: 0 })
      .where(inArray(mailSuppressions.id, ids));
  }

  /** Counts a mail kept from each address. */
  async countSkipped(addresses: string[], at: Date) {
    await this.db
      .update(mailSuppressions)
      .set({
        skipped: sql`${mailSuppressions.skipped} + 1`,
        lastSkippedAt: at,
      })
      .where(inArray(mailSuppressions.address, addresses));
  }

  async insert(values: NewSuppression) {
    const [row] = await this.db
      .insert(mailSuppressions)
      .values(values)
      .returning();
    return row!;
  }

  async update(id: string, values: Partial<NewSuppression>) {
    const [row] = await this.db
      .update(mailSuppressions)
      .set(values)
      .where(eq(mailSuppressions.id, id))
      .returning();
    return row!;
  }

  async delete(id: string) {
    await this.db.delete(mailSuppressions).where(eq(mailSuppressions.id, id));
  }

  /** Records an event once; undefined for a replay (the unique index decides). */
  async insertEvent(values: NewMailEvent) {
    const [row] = await this.db
      .insert(mailEvents)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: mailEvents.id });
    return row;
  }

  /** Deletes up to `limit` events created before `before`; how many went. */
  async deleteEventsBefore(before: Date, limit: number) {
    const old = this.db
      .select({ id: mailEvents.id })
      .from(mailEvents)
      .where(lt(mailEvents.createdAt, before))
      .limit(limit);
    const rows = await this.db
      .delete(mailEvents)
      .where(inArray(mailEvents.id, old))
      .returning({ id: mailEvents.id });
    return rows.length;
  }

  async emailOf(userId: string) {
    const [account] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    return account?.email;
  }

  async suppressionsOf(address: string) {
    return this.db
      .select()
      .from(mailSuppressions)
      .where(eq(mailSuppressions.address, address));
  }

  /** The address's latest events, newest first. */
  async eventsOf(address: string, limit: number) {
    return this.db
      .select()
      .from(mailEvents)
      .where(eq(mailEvents.address, address))
      .orderBy(desc(mailEvents.id))
      .limit(limit);
  }

  async deleteOfAddress(address: string) {
    await this.db.delete(mailEvents).where(eq(mailEvents.address, address));
    await this.db
      .delete(mailSuppressions)
      .where(eq(mailSuppressions.address, address));
  }
}
