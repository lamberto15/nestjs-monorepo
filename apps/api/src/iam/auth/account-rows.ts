import { getColumnTable, getTableName } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

/** A table of an account's own rows, as `movesWithAccount()` declared it. */
export interface AccountRowsEntry {
  readonly name: string;
  readonly table: PgTable;
  /** The column naming the account. */
  readonly column: PgColumn;
  /** `id`: it holds the account's id; `key`: its principal key, `user:<id>`. */
  readonly form: 'id' | 'key';
}

const declared = new Map<string, AccountRowsEntry>();

/**
 * Declares, next to a global table, that its rows are an account's own
 * (its passkeys, its second factor, its picture) and go with the account
 * when a tenant it belongs to moves to a server of its own
 * (modules/tenant-move copies them with it). `column` names the account:
 * its id, or with `{ form: 'key' }` its principal key `user:<id>`.
 *
 * A table of an account's rows left undeclared stays behind; the guard test
 * (modules/tenant-move/account-rows.spec.ts) fails on a table that points
 * at `users` and is neither declared nor listed there as staying, with why.
 *
 * ```ts
 * movesWithAccount(passkeys.userId);
 * ```
 */
export function movesWithAccount(
  column: PgColumn,
  { form = 'id' }: { form?: AccountRowsEntry['form'] } = {},
) {
  const table = getColumnTable<PgTable>(column);
  const name = getTableName(table);
  declared.set(name, { name, table, column, form });
}

/** Every table declared with `movesWithAccount()` so far, by name. */
export function accountRowTables(): readonly AccountRowsEntry[] {
  return [...declared.values()].sort((a, b) => a.name.localeCompare(b.name));
}
