import { bigint, pgSequence, pgTable, text } from 'drizzle-orm/pg-core';
import { at } from '../database/columns.js';

/** Distributed locks (@nestjs/locks, DrizzleLockStore): one row per lock key. */
export const locks = pgTable('locks', {
  key: text('key').primaryKey(),
  /** The holder's id; null once released. */
  owner: text('owner'),
  fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
  /** On the database's clock: every instance agrees on it. */
  expiresAt: at('expires_at').notNull(),
});

/** Fencing tokens for every key: a sequence never goes back, so they only grow. */
export const locksFencingTokenSeq = pgSequence('locks_fencing_token_seq');
