import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { outboxMessages } from '../ops/outbox-store.view.js';
import { notificationStored } from './notifications.events.js';
import {
  notificationPreferences,
  notifications,
  pushDevices,
} from './notifications.tables.js';
import type { PreferenceOverrides } from './notifications.types.js';
import type { QuietHours } from './quiet-hours.js';

type NewNotification = typeof notifications.$inferInsert;
type NewDevice = typeof pushDevices.$inferInsert;

/** A recipient's notifications whose channels were never served (but the `mandatory` types). */
interface Undelivered {
  recipient: string;
  before?: Date;
  mandatory: readonly string[];
}

/**
 * Notifications' queries: the stored notifications, their delivery
 * messages in the outbox, the recipients' preferences and push devices, in
 * the caller's tenant and transaction (`@InjectTransaction()`).
 */
@Injectable()
export class NotificationsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /**
   * Stores a notification; with a key, in one statement, the older row of
   * that key is replaced by a new one (a new id, so it is the newest),
   * counted up, unread and undelivered again. Its id.
   */
  async store(values: NewNotification) {
    const [row] = await this.db
      .insert(notifications)
      .values(values)
      .onConflictDoUpdate({
        target: [
          notifications.tenantId,
          notifications.recipient,
          notifications.key,
        ],
        targetWhere: isNotNull(notifications.key),
        set: {
          // uuidv7() is the column's default; a conflict doesn't apply defaults.
          id: sql`uuidv7()`,
          data: values.data,
          link: values.link,
          count: sql`${notifications.count} + 1`,
          readAt: null,
          deliveredAt: null,
          digest: null,
          digestDueAt: null,
          emailedAt: null,
        },
      })
      .returning({ id: notifications.id });
    return row!.id;
  }

  /** A page of a recipient's notifications and the total. */
  page(recipient: string, filter: SQL | undefined, query: ListQuery) {
    const where = and(eq(notifications.recipient, recipient), filter);
    return Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(and(where, afterCursor(notifications.id, query)))
        .orderBy(...pageOrder(notifications.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, notifications, where, query),
    ]);
  }

  /** A recipient's unread notifications, counted up to `cap + 1` at most (an exact count reads every row). */
  async countUnread(recipient: string, cap: number) {
    const unread = this.db
      .select({ one: sql`1` })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipient, recipient),
          isNull(notifications.readAt),
        ),
      )
      .limit(cap + 1)
      .as('unread');
    const [row] = await this.db.select({ rows: count() }).from(unread);
    return row?.rows ?? 0;
  }

  /** How many undelivered notifications, and how many of their delivery messages are pending. */
  async countUndelivered(which: Undelivered) {
    const ids = this.db
      .select({ id: sql<string>`${notifications.id}::text` })
      .from(notifications)
      .where(this.undelivered(which));
    const [stored] = await this.db
      .select({ rows: count() })
      .from(notifications)
      .where(this.undelivered(which));
    const [messages] = await this.db
      .select({ rows: count() })
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.topic, notificationStored.type),
          inArray(
            sql<string>`${outboxMessages.payload}->>'notificationId'`,
            ids,
          ),
        ),
      );
    return { notifications: stored?.rows ?? 0, messages: messages?.rows ?? 0 };
  }

  /** The ids of up to `limit` undelivered notifications. */
  async undeliveredIds(which: Undelivered, limit: number) {
    const rows = await this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(this.undelivered(which))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  /** Deletes the pending delivery messages of these notifications (none under a live lease): how many. */
  async deleteDeliveries(ids: string[], now: Date) {
    const removed = await this.db
      .delete(outboxMessages)
      .where(
        and(
          eq(outboxMessages.topic, notificationStored.type),
          inArray(
            sql<string>`${outboxMessages.payload}->>'notificationId'`,
            ids,
          ),
          or(
            isNull(outboxMessages.leaseUntil),
            lt(outboxMessages.leaseUntil, now.getTime()),
          ),
        ),
      )
      .returning({ id: outboxMessages.id });
    return removed.length;
  }

  /** Marks these undelivered notifications delivered and read, undigested: how many. */
  async settle(ids: string[], now: Date) {
    const settled = await this.db
      .update(notifications)
      .set({
        deliveredAt: now,
        readAt: sql`coalesce(${notifications.readAt}, ${now.toISOString()}::timestamptz)`,
        digest: null,
        digestDueAt: null,
      })
      .where(
        and(inArray(notifications.id, ids), isNull(notifications.deliveredAt)),
      )
      .returning({ id: notifications.id });
    return settled.length;
  }

  async find(id: string) {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, id));
    return row;
  }

  async findOf(recipient: string, id: string) {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.id, id), eq(notifications.recipient, recipient)),
      );
    return row;
  }

  /** Marks one read, unless it is already: the row, when it changed. */
  async markRead(id: string) {
    const [row] = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
      .returning();
    return row;
  }

  /** Marks up to `limit` of a recipient's unread ones read (created before `before`): how many. */
  async markReadBatch(
    recipient: string,
    before: Date | undefined,
    now: Date,
    limit: number,
  ) {
    const batch = this.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipient, recipient),
          isNull(notifications.readAt),
          before ? lt(notifications.createdAt, before) : undefined,
        ),
      )
      .limit(limit);
    const changed = await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(inArray(notifications.id, batch), isNull(notifications.readAt)),
      )
      .returning({ id: notifications.id });
    return changed.length;
  }

  /** Marks a recipient's unread ones of a type read: how many. */
  async markTypeRead(recipient: string, type: string) {
    const settled = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.recipient, recipient),
          eq(notifications.type, type),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return settled.length;
  }

  /** Deletes one of a recipient's: whether there was one. */
  async deleteOf(recipient: string, id: string) {
    const deleted = await this.db
      .delete(notifications)
      .where(
        and(eq(notifications.id, id), eq(notifications.recipient, recipient)),
      )
      .returning({ id: notifications.id });
    return deleted.length > 0;
  }

  async update(id: string, values: Partial<NewNotification>) {
    await this.db
      .update(notifications)
      .set(values)
      .where(eq(notifications.id, id));
  }

  async updateMany(ids: string[], values: Partial<NewNotification>) {
    await this.db
      .update(notifications)
      .set(values)
      .where(inArray(notifications.id, ids));
  }

  /** The recipients with digest items due by `now`. */
  async digestRecipients(now: Date) {
    const rows = await this.db
      .selectDistinct({ recipient: notifications.recipient })
      .from(notifications)
      .where(
        and(
          isNotNull(notifications.digest),
          lte(notifications.digestDueAt, now),
        ),
      );
    return rows.map((row) => row.recipient);
  }

  /** A recipient's digest items due by `now`, newest first. */
  digestItems(recipient: string, now: Date) {
    return this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipient, recipient),
          isNotNull(notifications.digest),
          lte(notifications.digestDueAt, now),
        ),
      )
      .orderBy(desc(notifications.id));
  }

  /**
   * Deletes up to `limit` notifications read before `readBefore` or
   * created before `createdBefore`: how many.
   */
  async deleteOld(readBefore: Date, createdBefore: Date, limit: number) {
    const old = or(
      and(
        isNotNull(notifications.readAt),
        lt(notifications.readAt, readBefore),
      ),
      lt(notifications.createdAt, createdBefore),
    );
    const rows = await this.db
      .delete(notifications)
      .where(
        inArray(
          notifications.id,
          this.db
            .select({ id: notifications.id })
            .from(notifications)
            .where(old)
            .limit(limit),
        ),
      )
      .returning({ id: notifications.id });
    return rows.length;
  }

  /** A recipient's notifications older than `cursor` (all, without it), newest first. */
  notificationsOf(
    recipient: string,
    cursor: string | undefined,
    limit: number,
  ) {
    return this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.recipient, recipient),
          cursor ? lt(notifications.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(limit);
  }

  async deleteNotificationsOf(recipient: string) {
    await this.db
      .delete(notifications)
      .where(eq(notifications.recipient, recipient));
  }

  /** An active API client of the tenant, if it is one. */
  async findActiveClient(id: string) {
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(and(eq(apiClients.id, id), eq(apiClients.active, true)));
    return client;
  }

  async overridesOf(recipient: string): Promise<PreferenceOverrides> {
    const [row] = await this.db
      .select({ settings: notificationPreferences.settings })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.recipient, recipient));
    return row?.settings ?? {};
  }

  async quietHoursOf(recipient: string): Promise<QuietHours | null> {
    const [row] = await this.db
      .select({ quietHours: notificationPreferences.quietHours })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.recipient, recipient));
    return row?.quietHours ?? null;
  }

  async saveOverrides(recipient: string, settings: PreferenceOverrides) {
    await this.db
      .insert(notificationPreferences)
      .values({ recipient, settings })
      .onConflictDoUpdate({
        target: notificationPreferences.recipient,
        set: { settings },
      });
  }

  async saveQuietHours(recipient: string, quietHours: QuietHours | null) {
    await this.db
      .insert(notificationPreferences)
      .values({ recipient, quietHours })
      .onConflictDoUpdate({
        target: notificationPreferences.recipient,
        set: { quietHours },
      });
  }

  preferencesOf(recipient: string) {
    return this.db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.recipient, recipient));
  }

  async deletePreferencesOf(recipient: string) {
    await this.db
      .delete(notificationPreferences)
      .where(eq(notificationPreferences.recipient, recipient));
  }

  /** Registers a browser by its endpoint, or moves and refreshes it. */
  async saveDevice(endpoint: string, values: Omit<NewDevice, 'endpoint'>) {
    const [row] = await this.db
      .insert(pushDevices)
      .values({ ...values, endpoint })
      .onConflictDoUpdate({ target: pushDevices.endpoint, set: values })
      .returning();
    return row!;
  }

  /** A user's devices, the oldest first. */
  devicesOf(userId: string) {
    return this.db
      .select()
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId))
      .orderBy(pushDevices.createdAt);
  }

  async findDevice(id: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(pushDevices)
      .where(and(eq(pushDevices.id, id), eq(pushDevices.userId, userId)));
    return row;
  }

  /** Deletes one of a user's devices: its name, when there was one. */
  async deleteDevice(id: string, userId: string) {
    const [row] = await this.db
      .delete(pushDevices)
      .where(and(eq(pushDevices.id, id), eq(pushDevices.userId, userId)))
      .returning({ id: pushDevices.id, name: pushDevices.name });
    return row;
  }

  /** Deletes the browsers not seen since `before`: how many. */
  async deleteDevicesSeenBefore(before: Date) {
    const deleted = await this.db
      .delete(pushDevices)
      .where(lt(pushDevices.lastSeenAt, before))
      .returning({ id: pushDevices.id });
    return deleted.length;
  }

  /** A user's devices, without the keys that reach them. */
  deviceSummariesOf(userId: string) {
    return this.db
      .select({
        id: pushDevices.id,
        name: pushDevices.name,
        endpoint: pushDevices.endpoint,
        lastSeenAt: pushDevices.lastSeenAt,
        createdAt: pushDevices.createdAt,
      })
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId));
  }

  async deleteDevicesOf(userId: string) {
    await this.db.delete(pushDevices).where(eq(pushDevices.userId, userId));
  }

  private undelivered({ recipient, before, mandatory }: Undelivered) {
    return and(
      eq(notifications.recipient, recipient),
      isNull(notifications.deliveredAt),
      before ? lt(notifications.createdAt, before) : undefined,
      mandatory.length > 0
        ? notInArray(notifications.type, [...mandatory])
        : undefined,
    );
  }
}
