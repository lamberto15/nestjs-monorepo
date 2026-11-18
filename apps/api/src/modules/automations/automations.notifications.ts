import { z } from 'zod';
import { defineNotifications } from '../notifications/notifications.types.js';

/** What a rule's `notify` action tells (texts: i18n/en.json, `notifications.automation.notified`). */
export const AUTOMATION_NOTIFICATIONS = defineNotifications([
  {
    type: 'automation.notified',
    email: 'immediate',
    data: z.object({
      rule: z.string(),
      subject: z.string(),
      recordId: z.uuid(),
      title: z.string(),
    }),
  },
]);
