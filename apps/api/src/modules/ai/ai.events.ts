import { z } from 'zod';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';

const run = {
  id: z.uuid(),
  subject: z.string(),
  recordId: z.uuid(),
};

/** The requester's run finished: read it at GET /v1/ai/runs/{id}. */
export const aiReady = defineRealtimeEvent(
  'ai.ready',
  z.object({ ...run, task: z.string() }),
  'An AI run you asked for finished: read the answer at GET /v1/ai/runs/{id}.',
);

/** The requester's run failed for good; `error` is the code of ai.errors. */
export const aiFailed = defineRealtimeEvent(
  'ai.failed',
  z.object({ ...run, error: z.string() }),
  'An AI run you asked for failed for good; error is its code.',
);
