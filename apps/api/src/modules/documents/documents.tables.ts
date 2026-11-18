import { sql } from 'drizzle-orm';
import { index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

export const DOCUMENT_STATUSES = [
  'queued',
  'rendering',
  'completed',
  'failed',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/**
 * Documents asked for (a PDF of a record): the request, then its job's
 * state, then the issued file on the private disk. Issued documents never
 * change: asking again issues a new one. They go with their record when it
 * is deleted for good (DocumentsExtension.purged).
 */
export const documents = tenantTable(
  'documents',
  {
    id: uuidPk(),
    /** The record's collection path (`notes`): which DocumentsModule.forRecord() serves it. */
    source: text('source').notNull(),
    /** The template it was made from (a name in the templates folder). */
    template: text('template').notNull(),
    /** The record's permission subject (`Note`) and id. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The language it is written in (the request's) and the time zone of its dates. */
    locale: text('locale').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status').$type<DocumentStatus>().notNull(),
    /** `user:<id>` or `client:<id>`. */
    requestedBy: text('requested_by').notNull(),
    /** The issued PDF on the disk, and its name and size. */
    fileKey: text('file_key'),
    fileName: text('file_name'),
    size: integer('size'),
    /**
     * The record's fields the PDF shows (`title`, `body`…): whoever reads
     * or downloads it must be allowed every one of them now.
     */
    fields: text('fields').array().notNull().default([]),
    /**
     * The render that holds the document (a new token per run): only it may
     * complete it, so a run started twice (a stalled job) issues one PDF.
     */
    runToken: uuid('run_token'),
    /** Once issued: the PDF as a locked attachment of the record (modules/attachments). */
    attachmentId: uuid('attachment_id'),
    /** Why it failed: a code of `documents.errors` in the catalog. */
    error: text('error'),
    issuedAt: at('issued_at'),
    ...timestamps(),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('documents_tenant_idx').on(t.tenantId),
    index('documents_record_idx').on(t.subject, t.recordId),
    index('documents_requested_by_idx').on(t.requestedBy),
    // One document at a time per record, requester and language.
    uniqueIndex('documents_pending_idx')
      .on(t.tenantId, t.source, t.recordId, t.requestedBy, t.locale)
      .where(sql`${t.status} in ('queued', 'rendering')`),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
