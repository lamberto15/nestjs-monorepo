import { isNotNull, isNull } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';
import { users } from '../../iam/auth/auth.tables.js';
import { movesWithAccount } from '../../iam/auth/account-rows.js';
import type { DigestMode, PreferenceOverrides } from './notifications.types.js';
import type { QuietHours } from './quiet-hours.js';

/**
 * What a recipient was told: the in-app notification, kept until the
 * retention job removes it. The texts are not stored: `type` and `data`
 * render them in the reader's language when they are read.
 */
export const notifications = tenantTable(
  'notifications',
  {
    id: uuidPk(),
    /** Who it's for: `user:<id>` or `client:<id>`. */
    recipient: text('recipient').notNull(),
    /** A declared type: `note.published`. */
    type: text('type').notNull(),
    /** The placeholders of the title and body (`{title}`), and what a client needs to act. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    /** The collapse key: a newer notification with the same key replaces this one, counted up. */
    key: text('key'),
    /** How many notifications this one stands for (collapsed). */
    count: integer('count').notNull().default(1),
    /** Where to go about it: a path of the web app. */
    link: text('link'),
    readAt: at('read_at'),
    /** The channels were served (or the recipient was gone). */
    deliveredAt: at('delivered_at'),
    /** Awaiting a digest mail, and when it is due. */
    digest: text('digest').$type<DigestMode>(),
    digestDueAt: at('digest_due_at'),
    emailedAt: at('emailed_at'),
    ...timestamps(),
  },
  (t) => [
    // Retention's `read_at < …` (or `created_at < …`): both sides indexed.
    index('notifications_read_at_idx').on(t.readAt).where(isNotNull(t.readAt)),
    // The list (newest first) and its cursor, and the unread count.
    index('notifications_recipient_id_idx').on(t.tenantId, t.recipient, t.id),
    index('notifications_recipient_unread_idx')
      .on(t.tenantId, t.recipient, t.id)
      .where(isNull(t.readAt)),
    // A collapsing type keeps one row per recipient and key.
    uniqueIndex('notifications_recipient_key_idx')
      .on(t.tenantId, t.recipient, t.key)
      .where(isNotNull(t.key)),
    index('notifications_digest_due_idx')
      .on(t.digestDueAt)
      .where(isNotNull(t.digestDueAt)),
    index('notifications_created_at_idx').on(t.createdAt),
  ],
);

/**
 * A recipient's notification preferences: only what differs from the
 * types' defaults, so a change to a type's defaults in code applies to
 * everyone who didn't override it. Global: a person's preferences are
 * theirs in every tenant.
 */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: uuidPk(),
    /** `user:<id>`. */
    recipient: text('recipient').notNull(),
    settings: jsonb('settings')
      .$type<PreferenceOverrides>()
      .notNull()
      .default({}),
    /** Push waits while the clock of the user's time zone is in this window (urgent types go through); null: none. */
    quietHours: jsonb('quiet_hours').$type<QuietHours>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('notification_preferences_recipient_idx').on(t.recipient),
  ],
);

/**
 * A browser a user registered for web push: the push service's endpoint and
 * the keys its messages are encrypted for. Global (a person's device, in
 * every tenant). The `auth` secret is encrypted at rest (core/encryption);
 * the endpoint and the public key are not secrets by themselves: sending
 * needs the deployment's VAPID private key.
 */
export const pushDevices = pgTable(
  'push_devices',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What the user calls it ("Firefox on the laptop"). */
    name: text('name').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: encryptedText('auth').notNull(),
    /** Refreshed each time the app registers it again; the retention sweep reads it. */
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('push_devices_endpoint_idx').on(t.endpoint),
    index('push_devices_user_id_idx').on(t.userId),
  ],
);
encrypted(pushDevices.auth);

/**
 * Who watches which record: a subscriber (a principal key) and a record (its
 * permission subject and id). A module notifies the watchers of a record when
 * it changes (`SubscriptionsService.notifyWatchers`).
 */
export const recordSubscriptions = tenantTable(
  'record_subscriptions',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: text('record_id').notNull(),
    /** `user:<id>` or `client:<id>`. */
    subscriber: text('subscriber').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('record_subscriptions_record_subscriber_idx').on(
      t.tenantId,
      t.subject,
      t.recordId,
      t.subscriber,
    ),
    // One subscriber's watch list in id order (GET /subscriptions).
    index('record_subscriptions_subscriber_id_idx').on(
      t.tenantId,
      t.subscriber,
      t.id,
    ),
  ],
);

/** What goes with the account when a tenant it belongs to moves to its own server (iam/auth/account-rows.ts). */
movesWithAccount(notificationPreferences.recipient, { form: 'key' });
