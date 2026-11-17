import { text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at } from '../../../../src/core/database/columns.js';
import { tenantTable } from '../../../../src/core/tenancy/tenant-tables.js';

/**
 * The marks of any record (a test-only add-on proving the extension
 * contract, modules/records/README.md): kept in its own table by subject
 * and record id, as an add-on keeps its data.
 */
export const testRecordMarks = tenantTable(
  'test_record_marks',
  {
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    mark: text('mark').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('test_record_marks_idx').on(
      t.tenantId,
      t.subject,
      t.recordId,
      t.mark,
    ),
  ],
);

/**
 * The records whose `created` event the add-on saw (its subscriber): kept
 * apart from the marks, as what an add-on shows must not change after the
 * record's write (it is in the ETag).
 */
export const testRecordSeen = tenantTable(
  'test_record_seen',
  {
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    seenAt: at('seen_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('test_record_seen_idx').on(t.tenantId, t.subject, t.recordId),
  ],
);
