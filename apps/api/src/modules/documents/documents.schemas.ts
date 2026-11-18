import { z } from 'zod';
import { publishSchemas } from '../../core/http/openapi.js';
import { pageSchema } from '../../core/http/pagination.js';
import { DOCUMENT_STATUSES } from './documents.tables.js';

const status = z
  .enum(DOCUMENT_STATUSES)
  .describe('queued → rendering → completed, or failed (then `error`).');
const error = z
  .string()
  .nullable()
  .describe('Why it failed, written for people (in the request’s language).');
const errorCode = z
  .string()
  .nullable()
  .describe('Why it failed, as a code: `rejected`, `unavailable`…');

/** A document asked for: its state, then the issued PDF (GET /v1/documents/{id}/download). */
export const documentSchema = z.object({
  id: z.uuid(),
  source: z
    .string()
    .meta({ example: 'notes' })
    .describe('The collection path of the record.'),
  subject: z.string().meta({ example: 'Note' }),
  recordId: z.uuid(),
  locale: z
    .string()
    .meta({ example: 'en' })
    .describe('The language it is written in.'),
  status,
  fileName: z.string().nullable().describe('Once completed: the PDF’s name.'),
  attachmentId: z
    .uuid()
    .nullable()
    .describe(
      'Once completed: the PDF as a locked attachment of the record (GET /v1/attachments/{id}/download).',
    ),
  size: z.int().nullable().describe('Once completed: its size in bytes.'),
  error,
  errorCode,
  issuedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DocumentView = z.infer<typeof documentSchema>;

/** A document handed to the workers: follow it at GET /v1/documents/{id}. */
export const documentQueuedSchema = z
  .object({
    id: z.uuid(),
    status: z.literal('queued'),
  })
  .meta({ id: 'DocumentQueued' });

/** A document of a record, as the record's documents list shows it. */
export const recordDocumentSchema = z
  .object({
    id: z.uuid(),
    status,
    template: z.string().meta({ example: 'pdf-record' }),
    language: z
      .string()
      .meta({ example: 'en' })
      .describe('The language it is written in (`?lang=` of the request).'),
    issuedBy: z
      .string()
      .meta({ example: 'user:0199a3f2-…' })
      .describe('Who asked for it: `user:<id>` or `client:<id>`.'),
    issuedByName: z
      .string()
      .nullable()
      .describe('Their name; null when the tenant has no name for them.'),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso
      .datetime()
      .nullable()
      .describe(
        'When it was issued (`completed`) or failed; null while queued or rendering.',
      ),
    error,
    errorCode,
  })
  .meta({ id: 'RecordDocument' });
export type RecordDocumentView = z.infer<typeof recordDocumentSchema>;

/** A page of a record's documents, newest first. */
export const recordDocumentPageSchema = pageSchema(recordDocumentSchema).meta({
  id: 'RecordDocumentPage',
});

// The record panels type their answers from these, with or without a feature.
publishSchemas('documents', documentQueuedSchema, recordDocumentPageSchema);
