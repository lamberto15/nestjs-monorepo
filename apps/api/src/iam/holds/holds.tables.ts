import {
  and,
  type AnyColumn,
  eq,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { index, QueryBuilder, text, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * Legal holds: records that must be kept whatever a retention rule, a
 * delete or an account deletion would do. A hold names a permission subject
 * (`Note`, or `User` for a person's account) and one record of it, or no
 * record to hold every record of the subject in the tenant. It is active
 * until released; the rows stay as the record of who held what and why.
 */
export const legalHolds = tenantTable(
  'legal_holds',
  {
    id: uuidPk(),
    /** The records' permission subject: `Note`; `User` holds a person's account. */
    subject: text('subject').notNull(),
    /** The held record; null holds every record of the subject. */
    recordId: uuid('record_id'),
    /** Why: a case, a request from a court or an authority. */
    reason: text('reason').notNull(),
    /** `user:<id>` or `client:<id>`. */
    placedBy: text('placed_by').notNull(),
    releasedAt: at('released_at'),
    releasedBy: text('released_by'),
    releaseNote: text('release_note'),
    ...timestamps(),
  },
  (t) => [
    index('legal_holds_active_idx')
      .on(t.tenantId, t.subject, t.recordId)
      .where(sql`released_at is null`),
    index('legal_holds_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);

export type LegalHoldRow = typeof legalHolds.$inferSelect;

/**
 * The condition "not under an active hold" for the records of `subject`
 * whose id column is `id`, as a correlated NOT EXISTS (the tenant's rows
 * only: the wall). For the SQL of a job that deletes or rewrites, so a held
 * record is never selected.
 */
export const notHeld = (subject: string, id: AnyColumn): SQL =>
  notExists(
    new QueryBuilder()
      .select({ one: sql`1` })
      .from(legalHolds)
      .where(
        and(
          eq(legalHolds.subject, subject),
          isNull(legalHolds.releasedAt),
          or(isNull(legalHolds.recordId), eq(legalHolds.recordId, id)),
        ),
      ),
  );
