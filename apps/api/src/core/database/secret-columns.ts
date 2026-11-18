import { getColumns } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

const declared = new WeakMap<PgTable, ReadonlySet<string>>();

/**
 * Declares, next to the table, the columns holding a credential, its hash
 * or a secret (encrypted ones included): no copy of the data takes them (a
 * tenant's export). A guard test (data-transfer/tenant-export.spec.ts) fails
 * on a tenant table's column whose name looks like one and is not here.
 *
 * ```ts
 * secretColumns(shares, [shares.tokenHash, shares.codeHash]);
 * ```
 */
export function secretColumns(table: PgTable, columns: readonly PgColumn[]) {
  const properties = Object.entries(getColumns(table));
  const names = columns.map((column) => {
    const found = properties.find(([, candidate]) => candidate === column);
    if (!found) {
      throw new Error('secretColumns(): a column of another table.');
    }
    return found[0];
  });
  declared.set(table, new Set([...(declared.get(table) ?? []), ...names]));
}

/** The properties of a table's secret columns (secretColumns()). */
export const secretColumnsOf = (table: PgTable): ReadonlySet<string> =>
  declared.get(table) ?? new Set();
