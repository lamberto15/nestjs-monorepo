import { z } from 'zod';
import { defineEvent } from '../../core/outbox/events.js';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';
import {
  notificationSchema,
  type NotificationView,
} from './notifications.schemas.js';

/**
 * A notification was stored and waits for its channels: published in the
 * transaction of the change that sent it, consumed by the delivery on a
 * worker (notifications.delivery.ts).
 */
export const notificationStored = defineEvent<{ notificationId: string }>(
  'notification.stored',
);

/**
 * A notification for an API client was delivered: the client's webhook
 * (`notification.created`, declared in notifications.module.ts), the item as
 * GET /notifications shows it, in the default language. `clientId` only
 * addresses it: the webhook's data drops it.
 */
export const notificationCreatedWebhook = defineEvent<
  NotificationView & { clientId: string }
>('notification.created');

/**
 * What the recipient's every connection hears, so a badge and a list stay
 * right across tabs: a new notification (the item), one read, all read up to
 * a moment, one removed, and the unread count after each of them.
 */
export const notificationCreated = defineRealtimeEvent(
  'notification',
  notificationSchema,
  "A new notification, in the recipient's language.",
);
export const notificationRead = defineRealtimeEvent(
  'notification.read',
  z.object({ id: z.uuid(), readAt: z.iso.datetime().nullable() }),
  'A notification was marked read (or unread: readAt null).',
);
export const notificationsReadAll = defineRealtimeEvent(
  'notifications.read-all',
  z.object({ before: z.iso.datetime().nullable(), updated: z.int() }),
  'before: what the call passed (null: all of them); updated: how many changed.',
);
export const notificationRemoved = defineRealtimeEvent(
  'notification.removed',
  z.object({ id: z.uuid() }),
  'A notification was removed.',
);
export const unreadCountChanged = defineRealtimeEvent(
  'notifications.unread-count',
  z.object({ unread: z.int(), unreadCapped: z.boolean() }),
  "After each of the above: the badge's number.",
);
