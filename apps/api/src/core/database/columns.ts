import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** An entity's primary key: a UUIDv7 (time-ordered, indexes well) from PostgreSQL 18's uuidv7(). */
export const uuidPk = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

/**
 * A point in time: timestamptz to the millisecond, read as a Date (UTC in
 * the API). A JavaScript Date holds milliseconds, so a value the API hands
 * out (a list cursor, a filter bound) compares equal to the stored one.
 */
export const at = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date', precision: 3 });

/**
 * When a record was created and last changed, for every entity table:
 * `...timestamps()`. Drizzle sets `updated_at` on every update
 * (`$onUpdate`), so writes don't have to remember it.
 */
export const timestamps = () => ({
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
