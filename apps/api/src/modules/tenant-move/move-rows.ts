import { getColumns, getTableName } from 'drizzle-orm';
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from 'drizzle-orm/pg-core';

/**
 * Rows as the archive keeps them: one JSON object per line, by the
 * table's properties (camelCase), as Drizzle reads them. JSON keeps every
 * type the tables use but one, a point in time (a Date, written as ISO
 * 8601): `decodeRow()` gives it back from the column's type.
 */
export const encodeRow = (row: Record<string, unknown>) =>
  `${JSON.stringify(row)}\n`;

/** A column PostgreSQL computes itself (`generated always`, identity): never written. */
const computed = (column: PgColumn) =>
  Boolean(
    (column as { generated?: unknown }).generated ??
    (column as { generatedIdentity?: unknown }).generatedIdentity,
  );

/** A table's row with what PostgreSQL computes itself left out: what a copy writes. */
export function writable(table: PgTable, row: Record<string, unknown>) {
  const columns = getColumns(table);
  return Object.fromEntries(
    Object.entries(row).filter(
      ([property]) => columns[property] && !computed(columns[property]),
    ),
  );
}

/**
 * A row read from the archive, ready to insert into `table`: its points in
 * time as Dates again, what PostgreSQL computes left out. A property the
 * table lacks is an archive of another schema: refused.
 */
export function decodeRow(
  table: PgTable,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const columns = getColumns(table);
  const decoded: Record<string, unknown> = {};
  for (const [property, value] of Object.entries(row)) {
    const column = columns[property];
    if (!column) {
      throw new Error(
        `${getTableName(table)} has no column ${property}: the archive is of another schema.`,
      );
    }
    if (computed(column)) continue;
    decoded[property] =
      value !== null && column.dataType === 'object date'
        ? new Date(value as string)
        : value;
  }
  return decoded;
}

/**
 * The tables in an order that inserts every row after the rows it points
 * at: each after the tables its foreign keys name (a key to itself aside:
 * selfReference()). The keys have no cycle (a migration would need a
 * deferred constraint); one would be refused here.
 */
export function insertOrder<T extends { table: PgTable }>(
  entries: readonly T[],
): T[] {
  const byTable = new Map(entries.map((entry) => [entry.table, entry]));
  const ordered: T[] = [];
  const state = new Map<PgTable, 'visiting' | 'done'>();
  const visit = (entry: T, path: string[]) => {
    const status = state.get(entry.table);
    if (status === 'done') return;
    const name = getTableName(entry.table);
    if (status === 'visiting') {
      throw new Error(
        `Foreign keys in a cycle: ${[...path, name].join(' → ')}.`,
      );
    }
    state.set(entry.table, 'visiting');
    for (const key of getTableConfig(entry.table).foreignKeys) {
      const target = byTable.get(key.reference().foreignTable);
      if (target && target.table !== entry.table)
        visit(target, [...path, name]);
    }
    state.set(entry.table, 'done');
    ordered.push(entry);
  };
  for (const entry of entries) visit(entry, []);
  return ordered;
}

/**
 * A column's property in its table's rows, by its name: a key declared in
 * a table's extra config (tenantReference()) holds copies of the columns,
 * not the columns themselves.
 */
function propertiesOf(table: PgTable) {
  const properties = Object.entries(getColumns(table));
  return (column: PgColumn) => {
    const found = properties.find(
      ([, candidate]) => candidate.name === column.name,
    );
    if (!found) {
      throw new Error(`${getTableName(table)} has no column ${column.name}.`);
    }
    return found[0];
  };
}

/** The table's own column of that name (see propertiesOf()). */
export function columnOf(table: PgTable, column: PgColumn): PgColumn {
  return getColumns(table)[propertiesOf(table)(column)] as PgColumn;
}

/** The property pointing at a row of the same table (a parent), and the one it points at. */
export function selfReference(
  table: PgTable,
): { child: string; parent: string } | undefined {
  const propertyOf = propertiesOf(table);
  for (const key of getTableConfig(table).foreignKeys) {
    const reference = key.reference();
    if (reference.foreignTable !== table) continue;
    // A tenant reference pairs tenant_id with itself: the other pair is the parent.
    const index = reference.columns.findIndex(
      (column, i) => column.name !== reference.foreignColumns[i]!.name,
    );
    if (index >= 0) {
      return {
        child: propertyOf(reference.columns[index]!),
        parent: propertyOf(reference.foreignColumns[index]!),
      };
    }
  }
  return undefined;
}

/**
 * The foreign keys of `table` to tables outside `inside` (a platform's
 * own rows, such as a quota plan): what the target must already hold.
 */
export function outsideReferences(
  table: PgTable,
  inside: ReadonlySet<PgTable>,
) {
  const propertyOf = propertiesOf(table);
  return getTableConfig(table)
    .foreignKeys.map((key) => key.reference())
    .filter((reference) => !inside.has(reference.foreignTable))
    .map((reference) => ({
      table: reference.foreignTable,
      properties: reference.columns.map(propertyOf),
      columns: reference.foreignColumns.map((column) =>
        columnOf(reference.foreignTable, column),
      ),
    }));
}
