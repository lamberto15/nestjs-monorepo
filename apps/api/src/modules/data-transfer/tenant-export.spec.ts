import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { tenantTables } from '../../core/tenancy/tenant-tables.js';
import { pagingKey } from './tenant-export.js';

const SRC = join(import.meta.dirname, '..', '..');

const tableFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tableFiles(join(dir, entry.name))
      : entry.name.endsWith('.tables.ts')
        ? [join(dir, entry.name)]
        : [],
  );

describe('a tenant export pages every table that names a tenant', () => {
  it('finds a key in each: a primary key, or a unique index on columns never null', async () => {
    for (const file of tableFiles(SRC)) await import(file);
    const without = tenantTables()
      .filter(({ table }) => pagingKey(getTableConfig(table)).length === 0)
      .map(({ name }) => name);
    expect(tenantTables().length).toBeGreaterThan(10);
    expect(without).toEqual([]);
  });
});
