import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import {
  AccessRecordFinder,
  type RecordFinder,
} from '../../iam/access/access-record-finder.js';
import { AccessService } from '../../iam/access/access.service.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import {
  NotificationsService,
  type NotifyInput,
} from './notifications.service.js';
import { recordSubscriptions } from './notifications.tables.js';
import { SUBSCRIPTION_LIST } from './subscriptions.lists.js';

type Who = Pick<Principal, 'kind' | 'id'>;

/** A record, by its permission subject and id. */
export interface RecordRef {
  subject: string;
  recordId: string;
}

/**
 * Watching records: a principal follows a record and is notified when it
 * changes. The module that owns the record decides who may watch (whoever
 * may read it), watches creators by default (`subscribe` in the create's
 * transaction), and tells the watchers in each change's transaction
 * (`notifyWatchers`, through the notification system: in-app, realtime,
 * mail or push as each prefers). Watching is the watcher's own:
 * `GET /subscriptions` lists theirs, `DELETE` ends one.
 */
@Injectable()
export class SubscriptionsService implements OnModuleInit {
  private readonly finders = new Map<string, RecordFinder>();

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly notifications: NotificationsService,
    private readonly discovery: DiscoveryService,
    private readonly access: AccessService,
  ) {}

  /** The record finders the owning modules marked (`@AccessRecordFinder('Note')`, iam/access). */
  onModuleInit() {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: AccessRecordFinder.KEY,
    })) {
      const subject = this.discovery.getMetadataByDecorator(
        AccessRecordFinder,
        wrapper,
      );
      if (subject && wrapper.instance) {
        this.finders.set(subject, wrapper.instance as RecordFinder);
      }
    }
  }

  /**
   * Starts watching a record the caller may read. The record is found as the
   * caller: one they may not read, a subject nobody can find records of and a
   * missing id are the same 404 (it never says which).
   */
  async watch(principal: Principal, record: RecordRef) {
    const row = await this.finders
      .get(record.subject)
      ?.find(record.recordId, principal);
    if (
      !row ||
      !(await this.access.can(principal, 'read', record.subject, row))
    ) {
      throw new NotFoundException({
        code: 'not_found',
        message: 'No such record, or you may not see it.',
      });
    }
    await this.subscribe(principal, record);
  }

  /**
   * Starts watching (again: no change). Joins the current transaction. The
   * system principal watches nothing (it gets no notifications): a job that
   * comments or creates a record isn't subscribed.
   */
  async subscribe(principal: Who, record: RecordRef) {
    if (principal.kind === 'system') return;
    await this.db
      .insert(recordSubscriptions)
      .values({ ...record, subscriber: principalKey(principal) })
      .onConflictDoNothing();
  }

  /** Stops watching; false when the principal wasn't. */
  async unsubscribe(principal: Who, record: RecordRef) {
    const deleted = await this.db
      .delete(recordSubscriptions)
      .where(this.one(principal, record))
      .returning({ id: recordSubscriptions.id });
    return deleted.length > 0;
  }

  async isWatching(principal: Who, record: RecordRef) {
    const [row] = await this.db
      .select({ id: recordSubscriptions.id })
      .from(recordSubscriptions)
      .where(this.one(principal, record));
    return row !== undefined;
  }

  /**
   * Which of a subject's records the principal watches, among `recordIds` (a
   * page's ids): one query. For `?include=watching`.
   */
  async watching(
    principal: Who,
    subject: string,
    recordIds: readonly string[],
  ): Promise<Set<string>> {
    if (recordIds.length === 0) return new Set();
    const rows = await this.db
      .select({ recordId: recordSubscriptions.recordId })
      .from(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, subject),
          eq(recordSubscriptions.subscriber, principalKey(principal)),
          inArray(recordSubscriptions.recordId, [...recordIds]),
        ),
      );
    return new Set(rows.map((row) => row.recordId));
  }

  /** The principal keys watching a record. */
  async watchers(record: RecordRef): Promise<string[]> {
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

  /**
   * Notifies the record's watchers, in the change's transaction, but
   * `except` (the one who made the change: they know). Returns the
   * notification ids.
   */
  async notifyWatchers(
    input: RecordRef & Omit<NotifyInput, 'to'> & { except?: Who | string },
  ) {
    const { subject, recordId, except, ...notification } = input;
    const skip =
      except === undefined
        ? null
        : typeof except === 'string'
          ? except
          : principalKey(except);
    const to = (await this.watchers({ subject, recordId })).filter(
      (watcher) => watcher !== skip,
    );
    return this.notifications.notify({ ...notification, to });
  }

  /** A page of what the principal watches. */
  async page(principal: Principal, query: ListQuery) {
    const where = and(
      eq(recordSubscriptions.subscriber, principalKey(principal)),
      SUBSCRIPTION_LIST.where(query),
    );
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(recordSubscriptions)
        .where(and(where, afterCursor(recordSubscriptions.id, query)))
        .orderBy(...pageOrder(recordSubscriptions.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, recordSubscriptions, where, query),
    ]);
    const page = toPage(rows, query, total);
    return {
      ...page,
      items: page.items.map((row) => ({
        subject: row.subject,
        recordId: row.recordId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Ends one of the principal's subscriptions, or a 404. */
  async remove(principal: Principal, record: RecordRef) {
    if (!(await this.unsubscribe(principal, record))) {
      throw new NotFoundException(
        `You are not watching ${record.subject} ${record.recordId}.`,
      );
    }
  }

  /** Records gone for good (a purge, a delete): nobody watches them any more. */
  /** A merge: the duplicate's watchers watch the survivor (once). */
  async merge(subject: string, from: string, to: string) {
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

  async forget(subject: string, recordIds: readonly string[]) {
    if (recordIds.length === 0) return;
    await this.db
      .delete(recordSubscriptions)
      .where(
        and(
          eq(recordSubscriptions.subject, subject),
          inArray(recordSubscriptions.recordId, [...recordIds]),
        ),
      );
  }

  /** A principal is gone (their account deleted): they watch nothing. */
  async erase(principal: Who) {
    await this.db
      .delete(recordSubscriptions)
      .where(eq(recordSubscriptions.subscriber, principalKey(principal)));
  }

  private one(principal: Who, record: RecordRef) {
    return and(
      eq(recordSubscriptions.subject, record.subject),
      eq(recordSubscriptions.recordId, record.recordId),
      eq(recordSubscriptions.subscriber, principalKey(principal)),
    );
  }
}
