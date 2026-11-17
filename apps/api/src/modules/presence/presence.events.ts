import { z } from 'zod';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';

/**
 * Someone started or stopped viewing or editing a record you are viewing (or
 * one you are editing, for your other tabs): ids only, fetch
 * `GET /v1/presence/{subject}/{recordId}`. Advisory, never a lock.
 */
export const recordPresence = defineRealtimeEvent(
  'record.presence',
  z.object({ subject: z.string(), recordId: z.string() }),
);
