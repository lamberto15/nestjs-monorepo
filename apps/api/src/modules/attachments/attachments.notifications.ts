import { z } from 'zod';
import { defineNotifications } from '../notifications/notifications.types.js';

/** What attachments tell people (texts: `i18n/en.json`, under `notifications.attachment`). */
export const ATTACHMENT_NOTIFICATIONS = defineNotifications([
  // To the uploader: their file was flagged as malware and removed.
  {
    type: 'attachment.rejected',
    email: 'immediate',
    data: z.object({
      name: z.string(),
      subject: z.string(),
      signature: z.string(),
    }),
  },
]);
