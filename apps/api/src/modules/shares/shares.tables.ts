import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * Read-only links to one record: who made it, which of the record's fields
 * it shows, until when, to whom (a verified address, or anyone holding the
 * link). Only the link's hash is kept: the link itself is shown once, to
 * its maker. A tenant table: the link names its tenant, so it is looked up
 * in that tenant's scope, as an invitation is.
 */
export const recordShares = tenantTable(
  'record_shares',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    /** The record's fields the link shows, by name: never a reference to another record. */
    fields: jsonb('fields').$type<string[]>().notNull(),
    /** Whether it lists the record's files and hands out their download links. */
    files: boolean('files').notNull().default(false),
    /** The SHA-256 of the link's token, base64url. */
    tokenHash: text('token_hash').notNull(),
    /** Normalized; set: the link opens only with a code mailed to this address. */
    recipientEmail: text('recipient_email'),
    /** The SHA-256 of the last mailed code, bound to this link. */
    codeHash: text('code_hash'),
    codeExpiresAt: at('code_expires_at'),
    codeAttempts: integer('code_attempts').notNull().default(0),
    /** `user:<id>` of who made it. */
    createdBy: text('created_by').notNull(),
    expiresAt: at('expires_at').notNull(),
    revokedAt: at('revoked_at'),
    revokedBy: text('revoked_by'),
    views: integer('views').notNull().default(0),
    lastViewedAt: at('last_viewed_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('record_shares_token_idx').on(t.tenantId, t.tokenHash),
    index('record_shares_record_idx').on(t.tenantId, t.subject, t.recordId),
  ],
);

export type RecordShareRow = typeof recordShares.$inferSelect;
