import { index, text, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';

/**
 * Comments on records of any record type (the record by its permission
 * subject and id), with the people they mention. Deleted for good, not to a
 * recycle bin; every write is audited. A comment may answer a top-level one
 * (`parentId`, one level of replies); a top-level comment is a thread that
 * can be resolved.
 */
export const comments = tenantTable(
  'comments',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** `user:<id>` or `client:<id>`. */
    author: text('author').notNull(),
    body: text('body').notNull(),
    /** The principal keys mentioned (`@ada@example.com`, `@user:<id>`) who may read the record. */
    mentions: text('mentions').array().notNull().default([]),
    editedAt: at('edited_at'),
    /** The top-level comment this one answers; null for a top-level comment. Replies go with it. */
    parentId: uuid('parent_id'),
    /** Set on a top-level comment while its thread is resolved. */
    resolvedAt: at('resolved_at'),
    /** Who resolved it: `user:<id>` or `client:<id>`. */
    resolvedBy: text('resolved_by'),
    ...timestamps(),
  },
  (t) => [
    index('comments_record_idx').on(t.subject, t.recordId, t.id),
    index('comments_author_idx').on(t.author),
    index('comments_mentions_idx').using('gin', t.mentions),
    index('comments_parent_idx').on(t.parentId),
    tenantReference(
      'comments_parent_fk',
      [t.tenantId, t.parentId],
      [t.tenantId, t.id],
    ),
  ],
  { referenced: true },
);
