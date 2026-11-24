import { index, jsonb, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { timestamps } from '../../core/database/columns.js';
import { globalTable, tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * Named sets of limits the operators define (`free`, `pro`): quota key to
 * limit. The plan named `default` holds for every tenant without one. Not a
 * tenant's data: global.
 */
export const quotaPlans = pgTable('quota_plans', {
  name: text('name').primaryKey(),
  limits: jsonb('limits').$type<Record<string, number>>().notNull().default({}),
  ...timestamps(),
});

/**
 * What the operators set for one tenant: its plan, and limits of its own
 * that win over the plan's. Global with the tenant named: operators write
 * it from outside the tenant, and limits are read wherever work runs.
 */
export const tenantQuotas = globalTable(
  'tenant_quotas',
  {
    plan: text('plan').references(() => quotaPlans.name, {
      onDelete: 'set null',
    }),
    limits: jsonb('limits')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId] }),
    // The foreign key to quota_plans: a plan's delete finds its tenants.
    index('tenant_quotas_plan_idx').on(t.plan),
  ],
);

/**
 * One row per tenant and stock quota, there only to be locked: a check of
 * that quota locks its row until the commit, so parallel creates of one
 * thing never both take the last place while creates of other things don't
 * wait. A lock and not a counter of use: each module counts what it owns
 * (`count()`), and every delete, purge and resize would have to keep a
 * counter in step.
 */
export const quotaLocks = tenantTable(
  'quota_locks',
  { key: text('key').notNull() },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);
