import { index, jsonb, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * The tenant's pending and accepted invitations, one record for the whole
 * lifecycle of a member that isn't one yet: prepared (no link), sent (a
 * link until `expiresAt`), accepted. A withdrawn one is deleted.
 */
export const invitations = tenantTable(
  'invitations',
  {
    id: uuidPk(),
    /** Normalized, as `users.email`; null: prepared without one (sending needs it). */
    email: text('email'),
    /** The name a new account starts with (its owner changes it). */
    name: text('name'),
    roleIds: jsonb('role_ids').$type<string[]>().notNull().default([]),
    /** When each grant ends, by role id. */
    roleExpiresAt: jsonb('role_expires_at')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    unitIds: jsonb('unit_ids').$type<string[]>().notNull().default([]),
    /** The SHA-256 of the link's token, base64url; null: prepared, not sent. */
    tokenHash: text('token_hash'),
    /** `user:<id>` of who invited. */
    invitedBy: text('invited_by').notNull(),
    /** When the current link was sent; null: prepared, not sent. */
    sentAt: at('sent_at'),
    /** When the current link stops working; null: prepared, not sent. */
    expiresAt: at('expires_at'),
    acceptedAt: at('accepted_at'),
    acceptedBy: uuid('accepted_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invitations_tenant_token_idx').on(t.tenantId, t.tokenHash),
    index('invitations_tenant_email_idx').on(t.tenantId, t.email),
  ],
);
