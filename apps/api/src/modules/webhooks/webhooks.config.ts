import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../../core/config/env.js';
import { flag, integer } from '../../core/config/env.helpers.js';

export const schema = z.object({
  /** on: webhook endpoints may be http://127.0.0.1 and http://localhost (that address only), for a receiver on this machine. Never in production. */
  WEBHOOKS_ALLOW_LOOPBACK: flag('off'),
  /** The delivery worker, which signs and sends outgoing webhooks: off in tests (they drive it with runOnce()) and in a process that only dispatches. */
  WEBHOOKS_WORKER: flag('on'),
  /** Outgoing deliveries that succeeded or failed for good this many days ago are deleted every night, with their attempt logs. */
  WEBHOOKS_DELIVERY_RETENTION_DAYS: integer(30, { min: 1 }),
});

export const webhooksConfig = registerAs('webhooks', () => {
  const env = readEnv(schema);
  return {
    allowLoopback: env.WEBHOOKS_ALLOW_LOOPBACK,
    worker: env.WEBHOOKS_WORKER,
    retentionDays: env.WEBHOOKS_DELIVERY_RETENTION_DAYS,
  };
});
