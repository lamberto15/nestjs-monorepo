import { z } from 'zod';
import { defineNotifications } from '../notifications/notifications.types.js';

const data = z.object({
  subject: z.string(),
  recordId: z.uuid(),
  version: z.number().int(),
  title: z.string(),
  by: z.string(),
  dueAt: z.string().nullable(),
});

/** What acknowledgments tell people (texts: i18n/en.json, `notifications.acknowledgment`). */
export const ACKNOWLEDGMENT_NOTIFICATIONS = defineNotifications([
  // Someone asked the recipient to acknowledge a record.
  { type: 'acknowledgment.requested', email: 'immediate', data },
  // A reminder to acknowledge, from the one who asked.
  { type: 'acknowledgment.reminder', email: 'immediate', data },
]);
