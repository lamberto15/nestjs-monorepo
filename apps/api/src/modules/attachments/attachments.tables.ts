import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import type {
  RenditionStatus,
  StoredRenditions,
} from './attachments.renditions.js';

/**
 * Whether the file may be served: `clean` (scanned and found clean, or never
 * scanned because MALWARE_SCANNER is off, the default) or `pending` (stored,
 * its scan queued; downloads are refused until it is clean). An infected
 * file is not a state: the attachment is deleted.
 */
export type AttachmentScanStatus = 'pending' | 'clean';

/**
 * Files attached to records: a record (its permission subject and id), the
 * file on the private disk (`key`), and what it is. The bytes are on the
 * disk, never in the database; `contentType` was detected from them.
 */
export const attachments = tenantTable(
  'attachments',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** Where the file is on the private disk (StorageDisk): under `tenants/<tenant id>/`. */
    key: text('key').notNull(),
    /** The file name the client gave, shown and used for downloads. */
    name: text('name').notNull(),
    /** Bytes (ATTACHMENT_MAX_MB may exceed what an int4 counts). */
    size: bigint('size', { mode: 'number' }).notNull(),
    /** Detected from the bytes, not the client's claim. */
    contentType: text('content_type').notNull(),
    /** `user:<id>` or `client:<id>`. */
    uploadedBy: text('uploaded_by').notNull(),
    /** An issued document (a generated file): it never changes and nobody removes it; it goes with its record. */
    locked: boolean('locked').notNull().default(false),
    /**
     * The record's fields an issued document shows (`title`, `body`…): whoever
     * may not read every one of them does not see the attachment, and a share
     * link includes it only when its own fields cover them. Null for a file.
     */
    fields: text('fields').array(),
    /** `pending` only while a malware scan is queued (MALWARE_SCANNER); `clean` otherwise. */
    scanStatus: text('scan_status')
      .$type<AttachmentScanStatus>()
      .notNull()
      .default('clean'),
    /**
     * Where an uploaded image is in its processing (IMAGE_PROCESSING):
     * `pending` from the upload until the queue job has made its renditions
     * and stripped its metadata (`ready`), or could not (`failed`: the file
     * stays as uploaded). Null for what is not processed.
     */
    renditionStatus: text('rendition_status').$type<RenditionStatus>(),
    /** The thumbnail and the preview of an image: their keys on the private disk and sizes. `{}` until `ready`. */
    renditions: jsonb('renditions')
      .$type<StoredRenditions>()
      .notNull()
      .default({}),
    /** The number of the file the row holds now: 1, then one more with every replacement or restoration (the earlier files are `attachment_versions`). */
    version: integer('version').notNull().default(1),
    /** The note given with the current version, if any. */
    revisionNote: text('revision_note'),
    /** When the current version was put in place. */
    versionedAt: at('versioned_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('attachments_record_idx').on(t.subject, t.recordId),
    index('attachments_uploaded_by_idx').on(t.uploadedBy),
    // The scan retry job looks for the uploads stuck pending (a pending file is rare).
    index('attachments_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.scanStatus} = 'pending'`),
    // The image retry job looks for the images stuck pending.
    index('attachments_rendition_pending_idx')
      .on(t.updatedAt)
      .where(sql`${t.renditionStatus} = 'pending'`),
  ],
  { referenced: true },
);

export type Attachment = typeof attachments.$inferSelect;

/**
 * An upload announced and not completed: a signed PUT to the object store
 * (`POST …/attachments/presign`) or a resumable session (`…/sessions`). The
 * server's own record of what it allowed: the key is the server's, and the
 * record, uploader, size and type are what the completing request is checked
 * against, never the client's word. The object at `key` is not the
 * attachment's file: completion copies it to a key of the server's own.
 * Rows stay until the sweep (`AttachmentSweepJob`) removes them with their
 * objects once the link has expired.
 */
export const attachmentUploads = tenantTable(
  'attachment_uploads',
  {
    id: uuidPk(),
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** Where the client puts the object (a resumable session's parts are under `<key>.parts/`). */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Bytes the URL is signed for, or the session announced. */
    size: bigint('size', { mode: 'number' }).notNull(),
    /** The `Content-Type` the URL is signed for. */
    contentType: text('content_type').notNull(),
    /** `user:<id>` or `client:<id>`: only they may complete it. */
    uploadedBy: text('uploaded_by').notNull(),
    /** A resumable session rather than a signed URL: chunks through the API, on any storage driver. */
    resumable: boolean('resumable').notNull().default(false),
    /** Bytes of a resumable session stored so far: the next chunk's offset. */
    received: bigint('received', { mode: 'number' }).notNull().default(0),
    /** When the URL or the session stops working. */
    expiresAt: at('expires_at').notNull(),
    /** Set while a request completes it: a parallel one is refused (409). A claim older than a few minutes is a request that died. */
    completingAt: at('completing_at'),
    /** Set once the attachment exists. */
    completedAt: at('completed_at'),
    ...timestamps(),
  },
  (t) => [
    index('attachment_uploads_expires_idx').on(t.expiresAt),
    index('attachment_uploads_uploaded_by_idx').on(t.uploadedBy),
  ],
);

export type AttachmentUpload = typeof attachmentUploads.$inferSelect;

/**
 * The earlier files of an attachment (replaced, or set aside by a
 * restoration). The bytes at `key` stay as they were until the attachment
 * goes; they count in the tenant's `storageBytes`.
 */
export const attachmentVersions = tenantTable(
  'attachment_versions',
  {
    id: uuidPk(),
    attachmentId: uuid('attachment_id').notNull(),
    /** The number it had as the attachment's file. */
    version: integer('version').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    note: text('note'),
    /** When it became the attachment's file. */
    uploadedAt: at('uploaded_at').notNull(),
    /** When it was replaced. */
    replacedAt: at('replaced_at').notNull().defaultNow(),
  },
  (t) => [
    unique('attachment_versions_attachment_version_key').on(
      t.tenantId,
      t.attachmentId,
      t.version,
    ),
    tenantReference(
      'attachment_versions_attachment_fk',
      [t.tenantId, t.attachmentId],
      [attachments.tenantId, attachments.id],
    ),
  ],
);

export type AttachmentVersion = typeof attachmentVersions.$inferSelect;
