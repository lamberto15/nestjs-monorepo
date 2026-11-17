import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { text } from 'drizzle-orm/pg-core';
import { at, uuidPk } from '../../src/core/database/columns.js';
import { tenantTable } from '../../src/core/tenancy/tenant-tables.js';

/**
 * A tenant table for the retention tests, declared as a module declares one.
 * Not a `*.tables.ts` file: no migration finds it; the test makes the table
 * itself, as the owner, with `createRetentionItems()`.
 */
export const retentionItems = tenantTable('e2e_retention_items', {
  id: uuidPk(),
  body: text('body'),
  createdAt: at('created_at').notNull().defaultNow(),
});

/** Makes the table with its wall, as the owner (the app's role may not create tables). */
export async function createRetentionItems(ownerUrl: string) {
  const owner = drizzle(ownerUrl);
  const check = sql`tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid)`;
  await owner.execute(sql`create table if not exists e2e_retention_items (
    id uuid primary key default uuidv7(),
    body text,
    created_at timestamptz(3) not null default now(),
    tenant_id uuid not null references tenants(id) on delete cascade
  )`);
  await owner.execute(
    sql`alter table e2e_retention_items enable row level security`,
  );
  await owner.execute(
    sql`alter table e2e_retention_items force row level security`,
  );
  await owner.execute(
    sql`create policy e2e_retention_items_wall on e2e_retention_items for all using (${check}) with check (${check})`,
  );
  await owner.$client.end();
}
