import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { flag, integer } from '../config/env.helpers.js';

export const schema = z.object({
  /** The outbox relay, which delivers events to their subscribers: off in tests, which drive it with runOnce(), and in a worker kept for heavy queues. */
  OUTBOX_RELAY: flag('on'),
  /** Outbox events the relay claims per poll. */
  OUTBOX_RELAY_BATCH_SIZE: integer(100, { min: 1 }),
  /** Outbox events the relay delivers at once. */
  OUTBOX_RELAY_CONCURRENCY: integer(10, { min: 1 }),
  /** Outbox dead letters (events given up on) older than this many days are deleted every night; requeue them before. */
  OUTBOX_DEAD_LETTER_RETENTION_DAYS: integer(14, { min: 1 }),
  /** Consumers' inbox records (which events each processed) older than this many days are deleted every night. */
  OUTBOX_INBOX_RETENTION_DAYS: integer(30, { min: 1 }),
});

export const outboxConfig = registerAs('outbox', () => {
  const env = readEnv(schema);
  // A requeued dead letter keeps its id, and the inbox is what recognizes it
  // as a redelivery: it must outlive the dead letters.
  if (env.OUTBOX_INBOX_RETENTION_DAYS < env.OUTBOX_DEAD_LETTER_RETENTION_DAYS) {
    throw new Error(
      'OUTBOX_INBOX_RETENTION_DAYS must not be shorter than OUTBOX_DEAD_LETTER_RETENTION_DAYS: a requeued dead letter would run its consumers again.',
    );
  }
  return {
    relay: env.OUTBOX_RELAY,
    batchSize: env.OUTBOX_RELAY_BATCH_SIZE,
    concurrency: env.OUTBOX_RELAY_CONCURRENCY,
    deadLetterDays: env.OUTBOX_DEAD_LETTER_RETENTION_DAYS,
    inboxDays: env.OUTBOX_INBOX_RETENTION_DAYS,
  };
});
