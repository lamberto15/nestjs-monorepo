import { sql } from 'drizzle-orm';
import {
  index,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';

/**
 * Tags (labels) administrators define per subject (`Note`): a name unique
 * per subject whatever its case, a colour, a description.
 */
export const tags = tenantTable(
  'tags',
  {
    id: uuidPk(),
    /** The records' permission subject: `Note`. */
    subject: text('subject').notNull(),
    name: text('name').notNull(),
    /** `#rrggbb`. */
    color: text('color'),
    description: text('description'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('tags_subject_name_idx').on(
      t.tenantId,
      t.subject,
      sql`lower(${t.name})`,
    ),
  ],
  { referenced: true },
);

/**
 * Which record carries which tag: a link row, added and removed, never
 * edited. Deleting a tag removes its links (cascade).
 */
export const recordTags = tenantTable(
  'record_tags',
  {
    tagId: uuid('tag_id').notNull(),
    /** The record's permission subject: `Note` (the tag's own). */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.recordId] }),
    index('record_tags_record_idx').on(t.subject, t.recordId),
    tenantReference(
      'record_tags_tag_fk',
      [t.tenantId, t.tagId],
      [tags.tenantId, tags.id],
    ),
  ],
);
