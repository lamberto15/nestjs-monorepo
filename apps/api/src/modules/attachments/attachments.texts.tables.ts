import { index, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { searchVector } from '../records/full-text.js';
import { attachments } from './attachments.tables.js';

/**
 * `ready`: the text was extracted (it may be empty: a scan without a text
 * layer). `failed`: the extractor refused the file (too large, over its time
 * or memory limit, damaged); it is not tried again for this file.
 */
export type AttachmentTextStatus = 'ready' | 'failed';

/**
 * The text of an attachment, for the search inside files
 * (ATTACHMENT_TEXT_SEARCH), extracted on a worker from the file at `key`. A
 * row whose `key` is no longer the attachment's (the file was replaced) never
 * matches and is extracted again; it goes with its attachment.
 */
export const attachmentTexts = tenantTable(
  'attachment_texts',
  {
    id: uuidPk(),
    attachmentId: uuid('attachment_id').notNull(),
    /** The file it was extracted from: the attachment's `key` then. */
    key: text('key').notNull(),
    status: text('status').$type<AttachmentTextStatus>().notNull(),
    /** At most `MAX_TEXT_CHARS` characters; empty when `failed`. */
    text: text('text').notNull().default(''),
    search: searchVector('search', ['text']),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('attachment_texts_attachment_idx').on(
      t.tenantId,
      t.attachmentId,
    ),
    index('attachment_texts_search_idx').using('gin', t.search),
    tenantReference(
      'attachment_texts_attachment_fk',
      [t.tenantId, t.attachmentId],
      [attachments.tenantId, attachments.id],
    ),
  ],
);
