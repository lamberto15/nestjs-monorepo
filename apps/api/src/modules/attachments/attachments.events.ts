import { z } from 'zod';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';

/** A record's attachments changed: a client reloads the panel. Ids and the action, never the file. */
export const recordAttachmentsChanged = defineRealtimeEvent(
  'record.attachments.changed',
  z.object({
    subject: z.string(),
    recordId: z.string(),
    attachmentId: z.string(),
    action: z.enum(['added', 'removed', 'scanned', 'processed']),
  }),
  "A file on a record you watch was added, removed, scanned clean or processed (an image's thumbnail and preview): ids only.",
);
