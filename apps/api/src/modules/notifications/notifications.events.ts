import { z } from 'zod';
import { defineEvent } from '../../core/outbox/events.js';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';
import { notificationSchema } from './notifications.schemas.js';

/**
 * A notification was stored and waits for its channels: published in the
 * transaction of the change that sent it, consumed by the delivery on a
 * worker (notifications.delivery.ts).
 */
export const notificationStored = defineEvent<{ notificationId: string }>(
  'notification.stored',
);

/**
 * What the recipient's every connection hears, so a badge and a list stay
 * right across tabs: a new notification (the item), one read, all read up to
 * a moment, one removed, and the unread count after each of them.
 */
export const notificationCreated = defineRealtimeEvent(
  'notification',
  notificationSchema,
);
export const notificationRead = defineRealtimeEvent(
  'notification.read',
  z.object({ id: z.uuid(), readAt: z.iso.datetime().nullable() }),
);
export const notificationsReadAll = defineRealtimeEvent(
  'notifications.read-all',
  z.object({ before: z.iso.datetime().nullable(), updated: z.int() }),
);
export const notificationRemoved = defineRealtimeEvent(
  'notification.removed',
  z.object({ id: z.uuid() }),
);
export const unreadCountChanged = defineRealtimeEvent(
  'notifications.unread-count',
  z.object({ unread: z.int(), unreadCapped: z.boolean() }),
);
