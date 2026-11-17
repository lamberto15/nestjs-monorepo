import type { IdempotencyStoredPayload } from '@nestjs/idempotency';
import { bigint, index, json, pgTable, text } from 'drizzle-orm/pg-core';

/**
 * One row per idempotency record: an in-flight lock, or a completed
 * response. Not a tenant table: the key's scope carries the tenant
 * (idempotency.scope.ts), and a record is looked up by its key alone.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    // SHA-256 of the record key: keys can be longer than an index entry allows.
    keyHash: text('key_hash').primaryKey(),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    // The attempt holding the lock; null once the record is completed.
    owner: text('owner'),
    // null while in flight. json, not jsonb: jsonb rejects NUL in strings.
    response: json('response').$type<IdempotencyStoredPayload>(),
    // Epoch milliseconds, the form the package's store contract uses.
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('idempotency_keys_expires_at_idx').on(table.expiresAt)],
);
