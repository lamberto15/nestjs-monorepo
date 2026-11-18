import { index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * A request that one person acknowledge one version of a record, and the
 * answer. It records that the person confirmed they read that version, and
 * when: not a signature. The rows go with the record when it is deleted for
 * good (the audit log keeps who confirmed what).
 */
export const recordAcknowledgments = tenantTable(
  'record_acknowledgments',
  {
    id: uuidPk(),
    /** The record's permission subject: `Policy`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The record's version when it was asked for (acknowledgmentVersions). */
    version: integer('version').notNull(),
    /** Who is asked: `user:<id>`. */
    recipient: text('recipient').notNull(),
    /** Who asked: `user:<id>` or `client:<id>`. */
    requestedBy: text('requested_by').notNull(),
    dueAt: at('due_at'),
    /** How many reminders were sent, and when the last was. */
    reminders: integer('reminders').notNull().default(0),
    lastRemindedAt: at('last_reminded_at'),
    acknowledgedAt: at('acknowledged_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('record_acknowledgments_version_recipient_idx').on(
      t.tenantId,
      t.subject,
      t.recordId,
      t.version,
      t.recipient,
    ),
    index('record_acknowledgments_recipient_idx').on(
      t.recipient,
      t.acknowledgedAt,
    ),
  ],
);

/**
 * A record's version, as acknowledgments count them: 1 until the record
 * changes after someone was first asked, then one more with each change, so
 * an edited record is acknowledged again. Only records someone was asked
 * about have a row.
 */
export const acknowledgmentVersions = tenantTable(
  'acknowledgment_versions',
  {
    id: uuidPk(),
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('acknowledgment_versions_record_idx').on(
      t.tenantId,
      t.subject,
      t.recordId,
    ),
  ],
);

export type RecordAcknowledgment = typeof recordAcknowledgments.$inferSelect;
