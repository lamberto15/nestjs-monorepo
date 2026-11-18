import { pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps } from '../../../core/database/columns.js';
import { users } from '../../../iam/auth/auth.tables.js';
import { movesWithAccount } from '../../../iam/auth/account-rows.js';

/**
 * A user's picture: the key of its file on the private disk
 * (`accounts/<user id>/avatar/<random>.<ext>`). Global (pgTable) like the
 * account it belongs to: the picture is the person's, whatever tenants they
 * are in. One row per user; no row, no picture.
 */
export const userAvatars = pgTable('user_avatars', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  ...timestamps(),
});

/** What goes with the account when a tenant it belongs to moves to its own server (iam/auth/account-rows.ts). */
movesWithAccount(userAvatars.userId);
