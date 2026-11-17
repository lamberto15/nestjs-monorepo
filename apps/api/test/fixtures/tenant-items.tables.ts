import { text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../src/core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../src/core/tenancy/tenant-tables.js';

/**
 * A tenant table for the tests only, declared as a module declares one:
 * names unique per tenant, and a parent within the tenant (a composite key).
 */
export const tenantItems = tenantTable(
  'test_tenant_items',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('test_tenant_items_name_idx').on(t.tenantId, t.name),
    tenantReference(
      'test_tenant_items_parent_fk',
      [t.tenantId, t.parentId],
      [t.tenantId, t.id],
    ),
  ],
  { referenced: true },
);
