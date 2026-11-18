import { z } from 'zod';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';

const run = {
  id: z.string(),
  subject: z.string(),
  action: z.string(),
};

/** Every 100 items of a queued run, to the principal who started it. */
export const bulkProgress = defineRealtimeEvent(
  'bulk.progress',
  z.object({
    ...run,
    processed: z.number(),
    done: z.number(),
    failed: z.number(),
  }),
  'A queued bulk run is running: items processed so far, every few items.',
);

/** A queued run ended. */
export const bulkFinished = defineRealtimeEvent(
  'bulk.finished',
  z.object({ ...run, done: z.number(), failed: z.number() }),
  'A queued bulk operation ended; its item results: GET /v1/bulk/{id}.',
);

/** A queued run failed for good (its worker was lost, its starter deactivated): items done stay done. */
export const bulkFailed = defineRealtimeEvent(
  'bulk.failed',
  z.object({ ...run, error: z.string() }),
  'A queued bulk run failed for good; items done stay done. error says why, for people.',
);
