import { bigint, jsonb, pgSchema, text } from 'drizzle-orm/pg-core';

/**
 * The outbox package's tables (`nest_outbox`, its Postgres store's schema
 * version 1), for what the package has no API for: counting and removing the
 * pending messages of a tenant (ops.backlog.ts) or of a person's undelivered
 * notifications (NotificationsService.settle()). Not a `*.tables.ts` file, so
 * drizzle-kit never generates DDL for them: the package's migration owns
 * them. Only the columns used are declared.
 */
const store = pgSchema('nest_outbox');

export const outboxMessages = store.table('messages', {
  id: text('id').notNull(),
  topic: text('topic').notNull(),
  payload: jsonb('payload'),
  headers: jsonb('headers'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  leaseUntil: bigint('lease_until', { mode: 'number' }),
});

export const outboxDeadLetters = store.table('dead_letters', {
  id: text('id').notNull(),
  topic: text('topic').notNull(),
  headers: jsonb('headers'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});
