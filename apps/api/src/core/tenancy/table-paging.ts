import { gt, type SQL, sql } from 'drizzle-orm';
import type { getTableConfig, PgColumn } from 'drizzle-orm/pg-core';

/**
 * The columns a table is paged by: its primary key, else its first unique
 * index or constraint made only of columns that are never null (a table
 * that keeps its rows unique by an index, as an add-on's does). What walks a
 * whole tenant pages every table by it (a tenant's export, its move).
 */
export function pagingKey(
  config: ReturnType<typeof getTableConfig>,
): PgColumn[] {
  const primary = config.columns.some((column) => column.primary)
    ? config.columns.filter((column) => column.primary)
    : (config.primaryKeys[0]?.columns ?? []);
  if (primary.length > 0) return primary;
  const candidates = [
    ...config.indexes
      .filter((index) => index.config.unique)
      .map((index) => index.config.columns as unknown[]),
    ...config.uniqueConstraints.map((unique) => unique.columns as unknown[]),
  ];
  // An index lists a column by name (with its order): find it in the table; an expression is none.
  const plain = candidates
    .map((entries) =>
      entries.map((entry) =>
        config.columns.find(
          (column) => column.name === (entry as { name?: unknown }).name,
        ),
      ),
    )
    .find((columns) => columns.every((column) => column?.notNull));
  return (plain as PgColumn[] | undefined) ?? [];
}

/** The rows after a key: one column compares directly; a composite key as a row comparison, which the builder lacks. */
export function afterKey(keys: PgColumn[], values: unknown[]): SQL {
  if (keys.length === 1) return gt(keys[0]!, values[0]);
  return sql`(${sql.join(keys, sql`, `)}) > (${sql.join(
    values.map((value, index) => sql.param(value, keys[index])),
    sql`, `,
  )})`;
}
