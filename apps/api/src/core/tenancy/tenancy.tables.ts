import { boolean, pgTable, text } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../database/columns.js';

/**
 * The tenants: each a customer, and a wall no row crosses. Global, not a
 * tenant table: work finds its tenant here before it has one. Every tenant
 * table's `tenant_id` references it.
 */
export const tenants = pgTable('tenants', {
  id: uuidPk(),
  /** A short handle in URLs and logs (`acme`). */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Off: nobody acts in it, and forEachTenant() skips it. */
  active: boolean('active').notNull().default(true),
  /**
   * Set: the tenant is read only (frozen) since then, for everyone and
   * every job: each of its transactions begins `READ ONLY`
   * (row-level-security.ts). A tenant being moved to another server is
   * frozen while it is exported (modules/tenant-move).
   */
  frozenAt: at('frozen_at'),
  ...timestamps(),
});

export type Tenant = typeof tenants.$inferSelect;
