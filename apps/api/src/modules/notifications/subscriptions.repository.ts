import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { recordSubscriptions } from './notifications.tables.js';

/** One record: its subject and id. */
interface Watched {
  subject: string;
  recordId: string;
}

/**
 * Who watches which record: the subscriptions' queries, in the caller's
 * tenant and transaction (`@InjectTransaction()`).
 */
@Injectable()
export class SubscriptionsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Subscribes, unless it already is. */
  async insert(record: Watched, subscriber: string) {
    await this.db
      .insert(recordSubscriptions)
      .values({ ...record, subscriber })
      .onConflictDoNothing();
  }

  /** Whether there was a subscription to delete. */
  async delete(record: Watched, subscriber: string) {
    const deleted = await this.db
      .delete(recordSubscriptions)
      .where(this.one(record, subscriber))
      .returning({ id: recordSubscriptions.id });
    return deleted.length > 0;
  }

  async exists(record: Watched, subscriber: string) {
    const [row] = await this.db
      .select({ id: recordSubscriptions.id })
      .from(recordSubscriptions)
      .where(this.one(record, subscriber));
    return row !== undefined;
  }

  /** Which of these records of a subject the subscriber watches. */
  async watchedIds(subscriber: string, subject: string, recordIds: string[]) {
    const rows = await this.db
      .select({ recordId: recordSubscriptions.recordId })
      .from(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, subject),
          eq(recordSubscriptions.subscriber, subscriber),
          inArray(recordSubscriptions.recordId, recordIds),
        ),
      );
    return rows.map((row) => row.recordId);
  }

  /** The subscribers of a record. */
  async watchers(record: Watched) {
    const rows = await this.db
      .select({ subscriber: recordSubscriptions.subscriber })
      .from(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, record.subject),
          eq(recordSubscriptions.recordId, record.recordId),
        ),
      );
    return rows.map((row) => row.subscriber);
  }

  /** A page of a subscriber's subscriptions and the total. */
  page(subscriber: string, filter: SQL | undefined, query: ListQuery) {
    const where = and(eq(recordSubscriptions.subscriber, subscriber), filter);
    return Promise.all([
      this.db
        .select()
        .from(recordSubscriptions)
        .where(and(where, afterCursor(recordSubscriptions.id, query)))
        .orderBy(...pageOrder(recordSubscriptions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, recordSubscriptions, where, query),
    ]);
  }

  /** The watchers of `from` watch `to` instead (once each). */
  async move(subject: string, from: string, to: string) {
    const moved = await this.db
      .delete(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, subject),
          eq(recordSubscriptions.recordId, from),
        ),
      )
      .returning();
    if (moved.length > 0) {
      await this.db
        .insert(recordSubscriptions)
        .values(
          moved.map(({ id: _id, ...watcher }) => ({
            ...watcher,
            recordId: to,
          })),
        )
        .onConflictDoNothing();
    }
  }

  async deleteForRecords(subject: string, recordIds: string[]) {
    await this.db
      .delete(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, subject),
          inArray(recordSubscriptions.recordId, recordIds),
        ),
      );
  }

  /** A subscriber's subscriptions, every column (their export). */
  of(subscriber: string) {
    return this.db
      .select()
      .from(recordSubscriptions)
      .where(eq(recordSubscriptions.subscriber, subscriber));
  }

  async deleteOf(subscriber: string) {
    await this.db
      .delete(recordSubscriptions)
      .where(eq(recordSubscriptions.subscriber, subscriber));
  }

  private one(record: Watched, subscriber: string) {
    return and(
      eq(recordSubscriptions.subject, record.subject),
      eq(recordSubscriptions.recordId, record.recordId),
      eq(recordSubscriptions.subscriber, subscriber),
    );
  }
}
