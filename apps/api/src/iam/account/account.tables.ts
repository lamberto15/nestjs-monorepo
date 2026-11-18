import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  encrypted,
  encryptedText,
} from '../../core/encryption/encrypted-columns.js';
import { users } from '../auth/auth.tables.js';
import { movesWithAccount } from '../auth/account-rows.js';

// Every table here is global (pgTable): what a person signs in with is
// theirs, whatever tenants they belong to.

/**
 * Accounts at OAuth / OpenID Connect providers, linked to a user: by
 * (provider, subject), never by email.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.subject] }),
    index('user_identities_user_id_idx').on(table.userId),
  ],
);

/**
 * A user's passkeys (WebAuthn credentials), each named by its owner. The
 * credential id and the public key are what the authenticator made; the
 * counter guards against a cloned authenticator (synced passkeys keep it
 * at 0).
 */
export const passkeys = pgTable(
  'passkeys',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** What the user calls it ("MacBook", "YubiKey 5C"). */
    name: text('name').notNull(),
    /** The credential id, base64url, as the authenticator reports it. */
    credentialId: text('credential_id').notNull().unique(),
    /** The COSE public key, base64url. */
    publicKey: text('public_key').notNull(),
    /** The signature counter last seen; a response with a lower one is refused. */
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    /** How the browser can reach the authenticator (`internal`, `hybrid`, `usb`…). */
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    /** `multiDevice`: a synced passkey; `singleDevice`: bound to one authenticator. */
    deviceType: text('device_type', {
      enum: ['singleDevice', 'multiDevice'],
    }).notNull(),
    /** Whether the passkey is backed up (synced) right now. */
    backedUp: boolean('backed_up').notNull().default(false),
    /** The authenticator model's id (all zeros with `none` attestation on many platforms). */
    aaguid: text('aaguid').notNull().default(''),
    lastUsedAt: at('last_used_at'),
    ...timestamps(),
  },
  (table) => [index('passkeys_user_id_idx').on(table.userId)],
);

/**
 * The hashes of an account's previous passwords (PASSWORD_HISTORY): kept
 * only while the history is on, pruned to the count it needs, so a new
 * password can be refused when it repeats one. The current password's
 * hash is `users.password_hash`.
 */
export const passwordHistory = pgTable(
  'password_history',
  {
    id: uuidPk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    /** When the password was replaced. */
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('password_history_user_id_idx').on(table.userId, table.createdAt),
  ],
);

/**
 * Each user's authenticator app (TOTP). The secrets are encrypted with
 * the deployment's data keys (core/encryption, DATA_ENCRYPTION_KEYS):
 * `id` is the user's id (an encrypted column's table needs an `id`).
 */
export const mfaAuthenticators = pgTable('mfa_authenticators', {
  /** The user's id. */
  id: uuid('id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secret: encryptedText('secret').notNull(),
  confirmed: boolean('confirmed').notNull(),
  pendingSecret: encryptedText('pending_secret'),
  lastUsedStep: integer('last_used_step'),
});
encrypted(mfaAuthenticators.secret);
encrypted(mfaAuthenticators.pendingSecret);

/** The SHA-256 of each unused recovery code (MfaService hashes them). */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.codeHash] })],
);

/** Wrong second-factor codes, for the lockout window (MfaService). */
export const mfaFailures = pgTable(
  'mfa_failures',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id').notNull(),
    failedAt: at('failed_at').notNull(),
  },
  (table) => [
    index('mfa_failures_user_id_failed_at_idx').on(
      table.userId,
      table.failedAt,
    ),
    index('mfa_failures_failed_at_idx').on(table.failedAt),
  ],
);

/** Sign-in links by email, by the SHA-256 of their token (and browser binding). */
export const magicLinks = pgTable(
  'magic_links',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    redirectTo: text('redirect_to'),
  },
  (table) => [index('magic_links_expires_at_idx').on(table.expiresAt)],
);

/** OAuth / OpenID Connect sign-ins in progress, by `state`. */
export const oidcLogins = pgTable(
  'oidc_logins',
  {
    state: text('state').primaryKey(),
    provider: text('provider').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    nonce: text('nonce'),
    redirectTo: text('redirect_to'),
    // Set for "connect your Google account" from a signed-in session.
    linkUserId: text('link_user_id'),
    linkSessionId: text('link_session_id'),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (table) => [index('oidc_logins_expires_at_idx').on(table.expiresAt)],
);

/** Password reset, invitation and email verification links, by the SHA-256 of their token. */
export const emailTokens = pgTable(
  'email_tokens',
  {
    id: text('id').primaryKey(),
    purpose: text('purpose', {
      enum: ['password-reset', 'email-verification'],
    }).notNull(),
    userId: text('user_id').notNull(),
    email: text('email').notNull(),
    fingerprint: text('fingerprint'),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (table) => [
    index('email_tokens_user_id_purpose_idx').on(table.userId, table.purpose),
    index('email_tokens_expires_at_idx').on(table.expiresAt),
  ],
);

/**
 * The devices an account signed in from (`deviceOf()`: the user agent
 * without versions, and the network), for the new-sign-in alert: a device
 * unseen for 30 days is new again.
 */
export const accountDevices = pgTable(
  'account_devices',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `deviceOf().hash`: a SHA-256, nothing readable. */
    device: text('device').notNull(),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.device] })],
);

/** What goes with the account when a tenant it belongs to moves to its own server (iam/auth/account-rows.ts). */
movesWithAccount(userIdentities.userId);
movesWithAccount(passkeys.userId);
movesWithAccount(passwordHistory.userId);
movesWithAccount(mfaAuthenticators.id);
movesWithAccount(mfaRecoveryCodes.userId);
movesWithAccount(accountDevices.userId);
