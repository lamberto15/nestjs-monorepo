import {
  boolean,
  index,
  integer,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * A tenant's choice for a declared retention rule (`RetentionModule.forFeature()`):
 * after how many days its records are purged or anonymised, and whether the
 * rule runs at all. A declared rule does nothing in a tenant until the
 * tenant has a row here with `enabled`.
 */
export const retentionPolicies = tenantTable(
  'retention_policies',
  {
    id: uuidPk(),
    /** The declared rule's name: `note`. */
    rule: text('rule').notNull(),
    /** Records older than this are purged or anonymised. */
    days: integer('days').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** The last time a run of this rule finished. */
    lastRunAt: at('last_run_at'),
    /** Records the last run purged or anonymised. */
    lastCount: integer('last_count'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('retention_policies_rule_idx').on(t.tenantId, t.rule),
    index('retention_policies_enabled_idx').on(t.tenantId, t.enabled),
  ],
);
