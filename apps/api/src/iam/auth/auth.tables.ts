import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  globalTable,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { secretColumns } from '../../core/database/secret-columns.js';

/**
 * People who sign in. Global: one account per address, whatever tenants it
 * belongs to (`memberships`). Only its owner changes it.
 */
export const users = pgTable('users', {
  id: uuidPk(),
  /** Trimmed, NFC, lower case (normalizeEmail()): two spellings are one account. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  /** scrypt, from PasswordHasher; never leaves UsersRepository. Null: no password (invited, or a provider only). */
  passwordHash: text('password_hash'),
  /** The owner proved the address. A password signs in only once it is (verify first). */
  emailVerified: boolean('email_verified').notNull().default(false),
  /** The language the user chose (one of LOCALES); null: the request's. */
  locale: text('locale'),
  /** The user's IANA time zone; null: the app's. */
  timezone: text('timezone'),
  /** Off: no session, token or sign-in of this account works. */
  active: boolean('active').notNull().default(true),
  /**
   * The first administrator's onboarding: the seeded address must be
   * replaced by a real, verified one (OnboardingGuard). False for everyone else.
   */
  onboardingEmail: boolean('onboarding_email').notNull().default(false),
  /** Likewise: the seeded password was generated and must be changed. */
  onboardingPassword: boolean('onboarding_password').notNull().default(false),
  ...timestamps(),
});

/**
 * Which tenants a user belongs to, and whether the membership is active:
 * what lets the user act in a tenant at all. Global with the tenant named
 * (globalTable()): a sign-in picks the session's tenant from them before
 * the request has one. What a membership may do lives in tenant tables
 * whose keys reference it.
 */
export const memberships = globalTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Off: the user can't act in this tenant (a session in it has no tenant). */
    active: boolean('active').notNull().default(true),
    /** When the user last chose this tenant: a new sign-in starts in the latest. */
    selectedAt: at('selected_at'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index('memberships_user_id_idx').on(t.userId),
  ],
);

/**
 * Browser sessions (@nestjs/authentication's SessionStore), by the SHA-256
 * of their cookie token. Global: a session is the person's; the tenant it
 * acts in is `metadata.tenantId`.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    lastActiveAt: at('last_active_at').notNull(),
    mfa: text('mfa', { enum: ['pending', 'verified'] }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

/** Refresh tokens of token clients (mobile apps, CLIs), by SHA-256 (RefreshTokenStore). */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull(),
    userId: text('user_id').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    familyExpiresAt: at('family_expires_at').notNull(),
    usedAt: at('used_at'),
    // A family is revoked when any of its tokens is: that covers a successor saved after the revocation.
    revoked: boolean('revoked').notNull().default(false),
    claims: jsonb('claims').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('refresh_tokens_family_id_idx').on(t.familyId),
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_family_expires_at_idx').on(t.familyExpiresAt),
  ],
);

/**
 * Systems that call the API with a key. Each belongs to one tenant and acts
 * in it alone. What auth needs to let one in; managing them is iam/access's.
 */
export const apiClients = tenantTable(
  'api_clients',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    /** Off: none of its keys works. */
    active: boolean('active').notNull().default(true),
    /** CIDRs (normalizeCidr()) its keys may be used from; empty: any address. */
    allowedCidrs: text('allowed_cidrs').array().notNull().default([]),
    ...timestamps(),
  },
  (t) => [uniqueIndex('api_clients_tenant_name_idx').on(t.tenantId, t.name)],
  { referenced: true },
);

/**
 * An API client's keys: several at once during a rotation. A key is
 * `sk_<keyId>_<secret>`; only its SHA-256 is stored. Global with the
 * tenant named (globalTable()): a key is found by its id before its
 * tenant is known; its client is then read in that tenant.
 */
export const apiKeys = globalTable(
  'api_keys',
  {
    id: uuidPk(),
    clientId: uuid('client_id').notNull(),
    /** The key's public id: the middle of `sk_<id>_<secret>`. */
    keyId: text('key_id').notNull().unique(),
    /** The SHA-256 of the whole key, base64url, as ApiKeyProvider compares it. */
    keyHash: text('key_hash').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    /** Refused from then on (a rotation's grace period ends here). */
    expiresAt: at('expires_at'),
    revokedAt: at('revoked_at'),
    /** Written at most once a minute. */
    lastUsedAt: at('last_used_at'),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('api_keys_tenant_idx').on(t.tenantId),
    index('api_keys_client_id_idx').on(t.clientId),
    tenantReference(
      'api_keys_client_fk',
      [t.tenantId, t.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
  ],
);

secretColumns(apiKeys, [apiKeys.keyHash]);
