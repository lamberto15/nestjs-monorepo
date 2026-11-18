import {
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/** What changed in a field, from → to. */
export type Changes = Record<string, { from: unknown; to: unknown }>;

/**
 * Each saved state of a record of any feature (by its permission subject
 * and id), numbered 1, 2, 3… per record: the fields a person may change
 * (`snapshot`) after each change, and what changed (`changes`). Restoring
 * one is a change like any other: a new revision, marked `restoredFrom`.
 */
export const revisions = tenantTable(
  'revisions',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** 1 for the record's first state, then one more per change. */
    number: integer('number').notNull(),
    /** The record's changeable fields after the change, as the API shows them. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    /** The fields that changed, from → to; null for the first. */
    changes: jsonb('changes').$type<Changes>(),
    /** The revision this one restored, when it was a restore. */
    restoredFrom: integer('restored_from'),
    /** `user:<id>` or `client:<id>`; `unknown` for a state from before revisions were kept. */
    changedBy: text('changed_by').notNull(),
    changedAt: at('changed_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    // The invariant: one revision per number of a record.
    uniqueIndex('revisions_record_number_uq').on(
      t.tenantId,
      t.subject,
      t.recordId,
      t.number,
    ),
    index('revisions_changed_by_idx').on(t.changedBy),
    index('revisions_changed_at_idx').on(t.changedAt),
  ],
);
