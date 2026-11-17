import { boolean, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { globalTable, tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * What the tenants module keeps about a tenant's life, one row per tenant
 * that has any (core/tenancy owns `tenants`): made by a self sign-up, and
 * its deletion's schedule. Global: the operators' routes and the nightly
 * jobs read it outside the tenant. Gone with the tenant (cascade).
 */
export const tenantLifecycle = globalTable(
  'tenant_lifecycle',
  {
    /** Made by a self sign-up (TENANT_SIGN_UP): the unverified sign-ups' sweep may delete it. */
    createdBySignUp: boolean('created_by_sign_up').notNull().default(false),
    /** An operator asked for its deletion; null: none pending. */
    deletionRequestedAt: at('deletion_requested_at'),
    /** When TenantDeletionJob erases it, unless cancelled before. */
    deletionScheduledFor: at('deletion_scheduled_for'),
    /** The erase began: no cancel from then on. */
    deletionStartedAt: at('deletion_started_at'),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.tenantId] })],
);

/**
 * A tenant's own domains: a hostname its people reach the app on
 * (`app.acme.com`), proved by a DNS TXT record. Unique per tenant only: a
 * tenant listing a hostname it doesn't control blocks nobody; the one
 * that proves it in DNS is routed (`tenant_domain_routes`).
 */
export const tenantDomains = tenantTable(
  'tenant_domains',
  {
    id: uuidPk(),
    /** Lower case, ASCII (an IDN in punycode), no trailing dot, no port. */
    hostname: text('hostname').notNull(),
    /** What the TXT record must hold; published in DNS, so not a secret. */
    verificationToken: text('verification_token').notNull(),
    /** Set while the record resolves; cleared when a check no longer finds it. */
    verifiedAt: at('verified_at'),
    lastCheckedAt: at('last_checked_at'),
    /** Why the last check failed (null once one succeeds). */
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('tenant_domains_tenant_hostname_idx').on(
      t.tenantId,
      t.hostname,
    ),
  ],
);

/**
 * Which tenant a verified hostname routes to, read before a request has a
 * tenant (SessionAuth, through @HostTenantResolver()). Global; one tenant
 * per hostname: the first to verify it. Kept with `tenant_domains` in the
 * same transactions.
 */
export const tenantDomainRoutes = globalTable('tenant_domain_routes', {
  hostname: text('hostname').primaryKey(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export type TenantLifecycle = typeof tenantLifecycle.$inferSelect;
export type TenantDomain = typeof tenantDomains.$inferSelect;
