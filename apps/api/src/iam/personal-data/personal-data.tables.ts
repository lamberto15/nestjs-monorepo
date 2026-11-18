import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { users } from '../auth/auth.tables.js';

// Global (pgTable): an account's deletion and consents are the person's,
// whatever tenants they belong to.

/**
 * A person's request to delete their account: carried out by the nightly
 * job once the grace period passed, unless cancelled before.
 */
export const accountDeletions = pgTable(
  'account_deletions',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedAt: at('requested_at').notNull().defaultNow(),
    /** When the job may carry it out: the request plus ACCOUNT_DELETION_GRACE_DAYS. */
    scheduledFor: at('scheduled_for').notNull(),
    cancelledAt: at('cancelled_at'),
    /** The job began carrying it out (claimed under the account's row lock): no cancel from then on. */
    startedAt: at('started_at'),
    /** The account was anonymised. */
    completedAt: at('completed_at'),
    ...timestamps(),
  },
  (t) => [
    index('account_deletions_user_id_idx').on(t.userId),
    index('account_deletions_scheduled_for_idx').on(t.scheduledFor),
  ],
);

/**
 * What a person agreed to, and when: one row per acceptance, kept as
 * proof, never overwritten. A withdrawal stamps the kind's rows still in
 * force; accepting again adds a row. A kind's state is its latest row.
 */
export const consents = pgTable(
  'consents',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** A declared kind (consent-kinds.ts): `terms`, `privacy`, `marketing`. */
    kind: text('kind').notNull(),
    /** Which version of it: `2026-01`. */
    version: text('version').notNull(),
    acceptedAt: at('accepted_at').notNull().defaultNow(),
    ip: text('ip'),
    withdrawnAt: at('withdrawn_at'),
    withdrawalIp: text('withdrawal_ip'),
  },
  (t) => [
    index('consents_user_kind_accepted_at_idx').on(
      t.userId,
      t.kind,
      t.acceptedAt,
    ),
  ],
);
