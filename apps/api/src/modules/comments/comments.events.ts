import { z } from 'zod';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';

/** A record's comments changed: a client reloads the panel. Ids and the action, never the text. */
export const recordCommented = defineRealtimeEvent(
  'record.commented',
  z.object({
    subject: z.string(),
    recordId: z.string(),
    commentId: z.string(),
    action: z.enum(['added', 'edited', 'removed', 'resolved', 'reopened']),
  }),
  'A comment on a record you watch (or one you wrote, for your other tabs) changed: ids only, fetch the thread.',
);
