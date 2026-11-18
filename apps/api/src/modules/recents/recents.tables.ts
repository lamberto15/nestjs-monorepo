import { index, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * The records a person opened lately, newest first: a bounded list of their
 * own. Only a pointer (the record's subject and id) and the title it
 * showed, never a field's content; the list checks the person can still
 * read the record before it shows the title.
 */
export const recentRecords = tenantTable(
  'recent_records',
  {
    id: uuidPk(),
    /** Whose it is: `user:<id>` or `client:<id>`. */
    owner: text('owner').notNull(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: text('record_id').notNull(),
    /** The name shown in the list, as it was when opened. */
    label: text('label').notNull(),
    viewedAt: at('viewed_at').notNull().defaultNow(),
  },
  (t) => [
    // Opening the same record again moves it to the top, not twice into the list.
    uniqueIndex('recent_records_owner_record_idx').on(
      t.tenantId,
      t.owner,
      t.subject,
      t.recordId,
    ),
    // One owner's list, newest first (GET /recents), and the bound on write.
    index('recent_records_owner_viewed_at_idx').on(t.owner, t.viewedAt),
    // The nightly sweep by age.
    index('recent_records_viewed_at_idx').on(t.viewedAt),
  ],
);
