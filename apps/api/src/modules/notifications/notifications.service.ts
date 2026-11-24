import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toPage } from '../../core/http/pagination.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { Realtime } from '../realtime/realtime.service.js';
import { NotificationCatalog } from './notifications.catalog.js';
import {
  notificationCreated,
  notificationRead,
  notificationRemoved,
  notificationsReadAll,
  notificationStored,
  unreadCountChanged,
} from './notifications.events.js';
import { Events } from '../../core/outbox/events.js';
import { NOTIFICATION_LIST } from './notifications.lists.js';
import { offered } from './notifications.preferences.js';
import type { NotificationView } from './notifications.schemas.js';
import { NotificationsRepository } from './notifications.repository.js';
import type { notifications } from './notifications.tables.js';

/** At most this many recipients per `notify()`: a broadcast is chunked through a queue job. */
export const MAX_RECIPIENTS = 500;

/** The unread count stops here (`unreadCapped`): counting a big backlog exactly costs a read of all of it. */
export const UNREAD_COUNT_CAP = 1_000;

/** Rows one read-all statement updates. */
export const READ_ALL_BATCH = 5_000;

type Row = typeof notifications.$inferSelect;
type Recipient = Pick<Principal, 'kind' | 'id'> | string;

export interface NotifyInput {
  type: string;
  /** Who gets it: principals, or their keys (`user:<id>`, `client:<id>`). */
  to: Recipient | readonly Recipient[];
  /** The placeholders of the title and body, and what a client needs to act. */
  data: Record<string, unknown>;
  /** A newer notification with the same key replaces the older one, counted up. */
  key?: string;
  /** Where to go about it: a path of the web app. */
  link?: string;
}

/**
 * Notifications (README.md): a module calls `notify()` inside the
 * transaction of its change, so the stored notification and its delivery
 * commit with it; a worker delivers it (notifications.delivery.ts). The
 * recipients read, mark and remove their own: nobody sees another's, and in
 * a tenant, that tenant's (row-level security). Each change is pushed to the
 * caller's other connections too, so a badge is right in every tab.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly catalog: NotificationCatalog,
    private readonly events: Events,
    private readonly realtime: Realtime,
  ) {}

  /**
   * Tells the recipients, in the current transaction (the change's): one
   * stored notification each, delivered by the worker once it commits.
   * Returns their ids. The system principal and an unnamed key are skipped.
   */
  async notify(input: NotifyInput): Promise<string[]> {
    if (!this.txHost.isTransactionActive()) {
      throw new Error(
        'notify() belongs in the transaction of the change (@Transactional()): the notification must commit or roll back with it.',
      );
    }
    const declaration = this.catalog.declaration(input.type);
    if (!declaration) {
      throw new Error(
        `Notification type "${input.type}" is not declared: NotificationsModule.forFeature() in the module that sends it.`,
      );
    }
    const data = (
      declaration.data ? declaration.data.parse(input.data) : input.data
    ) as Record<string, unknown>;
    const to: readonly Recipient[] = Array.isArray(input.to)
      ? input.to
      : [input.to as Recipient];
    // The system principal (a job that owns or watches a record) has nobody to tell.
    const recipients = [
      ...new Set(
        to.map((recipient) =>
          typeof recipient === 'string' ? recipient : principalKey(recipient),
        ),
      ),
    ].filter((recipient) => !recipient.startsWith('system:'));
    if (recipients.length > MAX_RECIPIENTS) {
      throw new Error(
        `notify() takes at most ${MAX_RECIPIENTS} recipients at once: chunk a broadcast through a queue job.`,
      );
    }
    const key =
      input.key ?? (declaration.collapse ? `type:${input.type}` : null);
    const link = input.link ?? null;
    const ids: string[] = [];
    for (const recipient of recipients) {
      // A key collapses in one statement (the repository's store()). No
      // lock: a concurrent notify of the same key waits on the row, then
      // counts up.
      const id = await this.repository.store({
        recipient,
        type: input.type,
        data,
        key,
        link,
      });
      ids.push(id);
      await this.events.publish(notificationStored, { notificationId: id });
    }
    return ids;
  }

  /** A test notification to the caller (`POST /notifications/test`), through the normal path. */
  async sendTest(principal: Principal) {
    const [id] = await this.txHost.withTransaction(() =>
      this.notify({
        type: 'notification.test',
        to: principal,
        data: { at: new Date().toISOString() },
      }),
    );
    return { id: id! };
  }

  /** A page of the caller's notifications, newest first, the texts in `locale` (default: the request's). */
  async page(principal: Principal, query: ListQuery, locale?: string) {
    const [rows, total] = await this.repository.page(
      principalKey(principal),
      NOTIFICATION_LIST.where(query),
      query,
    );
    const page = toPage(rows, query, total);
    return { ...page, items: page.items.map((row) => this.view(row, locale)) };
  }

  /** A stored notification as the API shows it, the texts in `locale` (default: the request's). */
  view(row: Row, locale?: string): NotificationView {
    const { title, body } = this.catalog.render(
      row.type,
      row.data,
      row.count,
      locale,
    );
    return {
      id: row.id,
      type: row.type,
      title,
      body,
      data: row.data,
      link: row.link,
      key: row.key,
      count: row.count,
      read: row.readAt !== null,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async unreadCount(principal: Pick<Principal, 'kind' | 'id'>) {
    // Capped, as countPage does: an exact count reads every unread row.
    const rows = await this.repository.countUnread(
      principalKey(principal),
      UNREAD_COUNT_CAP,
    );
    return rows > UNREAD_COUNT_CAP
      ? { unread: UNREAD_COUNT_CAP, unreadCapped: true }
      : { unread: rows, unreadCapped: false };
  }

  /**
   * A person's notifications whose channels were never served, mandatory
   * types (security notices) apart: what an operator may settle after a
   * storm. In the current tenant.
   */
  private undelivered(recipient: string, before?: Date) {
    const mandatory = this.catalog
      .declarations()
      .filter((declaration) => declaration.mandatory)
      .map((declaration) => declaration.type);
    return { recipient, before, mandatory };
  }

  /** What `settle()` would touch for a recipient in this tenant: notifications and their pending outbox messages. */
  async backlog(recipient: string, before?: Date) {
    return this.repository.countUndelivered(
      this.undelivered(recipient, before),
    );
  }

  /**
   * Settles up to `limit` of a recipient's undelivered notifications in this
   * tenant: their pending delivery messages are deleted (none under a live
   * lease) and they are marked delivered and read, so no push, mail or
   * webhook goes out for them; they stay in the list. Call again while it
   * returns something.
   */
  async settle(recipient: string, before: Date | undefined, limit: number) {
    const ids = await this.repository.undeliveredIds(
      this.undelivered(recipient, before),
      limit,
    );
    if (ids.length === 0) return { notifications: 0, messages: 0 };
    const now = new Date();
    const messages = await this.repository.deleteDeliveries(ids, now);
    const settled = await this.repository.settle(ids, now);
    return { notifications: settled, messages };
  }

  /** Marks one read (again: no change); the caller's connections hear `notification.read`. */
  async markRead(principal: Principal, id: string) {
    const found = await this.repository.findOf(principalKey(principal), id);
    if (!found) {
      throw new NotFoundException(`Notification ${id} not found.`);
    }
    if (found.readAt) {
      return this.view(found);
    }
    const row = await this.repository.markRead(id);
    const item = this.view(row ?? found);
    this.realtime.toPrincipal(principal, notificationRead, {
      id: item.id,
      readAt: item.readAt,
    });
    await this.announceUnread(principal);
    return item;
  }

  /**
   * Marks every unread one read (those created before `before`, when given);
   * how many changed. Works in batches of `READ_ALL_BATCH`, each its own
   * statement: a failure part-way leaves some rows read, which is harmless
   * and idempotent.
   */
  async markAllRead(principal: Principal, before?: Date) {
    const now = new Date();
    let updated = 0;
    for (;;) {
      const changed = await this.repository.markReadBatch(
        principalKey(principal),
        before,
        now,
        READ_ALL_BATCH,
      );
      updated += changed;
      if (changed < READ_ALL_BATCH) break;
    }
    if (updated > 0) {
      this.realtime.toPrincipal(principal, notificationsReadAll, {
        before: before?.toISOString() ?? null,
        updated,
      });
      await this.announceUnread(principal);
    }
    return { updated };
  }

  async remove(principal: Principal, id: string) {
    if (!(await this.repository.deleteOf(principalKey(principal), id))) {
      throw new NotFoundException(`Notification ${id} not found.`);
    }
    this.realtime.toPrincipal(principal, notificationRemoved, { id });
    await this.announceUnread(principal);
  }

  /** Tells the recipient's connections their unread count (after a change to it). */
  /**
   * Marks the recipient's unread notifications of `type` read, in the
   * current transaction: news the change settles (a breached password that
   * was changed). How many; the caller announces the unread count after the
   * commit.
   */
  async settleType(recipient: Pick<Principal, 'kind' | 'id'>, type: string) {
    return this.repository.markTypeRead(principalKey(recipient), type);
  }

  async announceUnread(recipient: Pick<Principal, 'kind' | 'id'>) {
    this.realtime.toPrincipal(
      recipient,
      unreadCountChanged,
      await this.unreadCount(recipient),
    );
  }

  /** Pushes a delivered notification to the recipient's connections. */
  pushCreated(
    recipient: Pick<Principal, 'kind' | 'id'>,
    item: NotificationView,
  ) {
    this.realtime.toPrincipal(recipient, notificationCreated, item);
  }

  /** The declared types as this caller sees them: label, whether mandatory, the defaults of their channels. */
  types(principal: Pick<Principal, 'kind'>, locale?: string) {
    const settable = this.catalog.settable(principal);
    return this.catalog.declarations().map((declaration) => ({
      type: declaration.type,
      label: this.catalog.label(declaration.type, locale),
      mandatory: declaration.mandatory === true,
      urgent: declaration.urgent === true,
      channels: Object.fromEntries(
        offered(declaration, settable).map((name) => [
          name,
          declaration[name] ?? false,
        ]),
      ),
    }));
  }
}
