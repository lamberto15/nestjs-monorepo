import { DiscoveryService } from '@nestjs/core';
import { getColumnTable, getColumns, getTableName } from 'drizzle-orm';
import { type PgColumn, type PgTable, text } from 'drizzle-orm/pg-core';
import type { Normalizer } from './data-cipher.js';

/**
 * Declaring encrypted columns, in two steps that both live in the module:
 *
 * 1. Next to the table, `encrypted()` says how a column is bound and indexed.
 * 2. On a provider of the module, `@EncryptedColumns([...])` lists the
 *    columns it owns. EncryptionService finds every such provider through
 *    Nest's DiscoveryService (boot check, re-encryption), so no central list
 *    of tables exists and removing a module removes its columns.
 *
 * ```ts
 * // customers.tables.ts
 * export const customers = pgTable('customers', {
 *   id: uuid('id').primaryKey(),
 *   tenantId: uuid('tenant_id').notNull(),
 *   taxNumber: encryptedText('tax_number'),
 *   taxNumberIndex: blindIndexText('tax_number_index'),
 * });
 * encrypted(customers.taxNumber, { blindIndex: customers.taxNumberIndex, normalize: normalizers.exact });
 *
 * // customers.service.ts
 * @EncryptedColumns([customers.taxNumber])
 * @Injectable()
 * export class CustomersService {}
 * ```
 */

/** A column holding encrypted values (`v1.<key>.<iv>.<ciphertext>.<tag>`, data-cipher.ts). */
export const encryptedText = (name: string) => text(name);

/** A column holding a blind index (`<key>.<mac>`) of an encrypted column. */
export const blindIndexText = (name: string) => text(name);

export interface EncryptedColumnOptions {
  /** The column keeping this one's blind index, for lookups by value. */
  blindIndex?: PgColumn;
  /** How a value is normalized before it is indexed (normalizers in data-cipher.ts); required with `blindIndex`. */
  normalize?: Normalizer;
  /**
   * The `table.column` its values are bound to, when it isn't the
   * column's own: a column renamed after values were written keeps its old
   * name here, or they no longer open (until re-encrypted under the new one).
   */
  aad?: `${string}.${string}`;
}

/** One declared encrypted column. */
export interface EncryptedColumn {
  readonly table: PgTable;
  readonly column: PgColumn;
  /** The column's property in the table's rows (camelCase). */
  readonly key: string;
  /** The table's and column's names the values are bound to. */
  readonly bindingTable: string;
  readonly bindingColumn: string;
  /** The `tenant_id` column of a tenant table: each row's binding names it. */
  readonly tenantColumn?: PgColumn;
  /** The table's primary key `id`, which the re-encryption pages by. */
  readonly id: PgColumn;
  readonly blindIndex?: {
    readonly column: PgColumn;
    readonly key: string;
    readonly normalize: Normalizer;
  };
}

/** What `encrypted()` declared, by Drizzle column: a lookup, not a list to walk. */
const declarations = new WeakMap<PgColumn, EncryptedColumn>();

const propertyOf = (table: PgTable, column: PgColumn) => {
  const entry = Object.entries(getColumns(table)).find(
    ([, candidate]) => candidate === column,
  );
  if (!entry) {
    throw new Error(
      `${column.name} is not a column of ${getTableName(table)}.`,
    );
  }
  return entry[0];
};

/** Declares `column` encrypted. Call it at module scope, next to its table. */
export function encrypted(
  column: PgColumn,
  options: EncryptedColumnOptions = {},
): EncryptedColumn {
  const table = getColumnTable<PgTable>(column);
  const tableName = getTableName(table);
  const where = `${tableName}.${column.name}`;
  if (declarations.has(column)) {
    throw new Error(`${where} is declared encrypted twice.`);
  }
  if (column.getSQLType() !== 'text') {
    throw new Error(`${where}: an encrypted column is text (encryptedText()).`);
  }
  if (options.blindIndex && !options.normalize) {
    throw new Error(
      `${where}: a blind index needs a normalizer (normalizers in core/encryption/data-cipher.ts).`,
    );
  }
  if (
    options.blindIndex &&
    getColumnTable(options.blindIndex) !== getColumnTable(column)
  ) {
    throw new Error(`${where}: its blind index must be in the same table.`);
  }
  const columns = getColumns(table);
  const id = columns.id as PgColumn | undefined;
  if (!id) {
    throw new Error(
      `${where}: an encrypted column's table needs an id column.`,
    );
  }
  const tenantColumn = Object.values(columns).find(
    (candidate) => candidate.name === 'tenant_id',
  );
  const [bindingTable, bindingColumn] = (options.aad ?? where).split('.');
  const key = propertyOf(table, column);
  const entry: EncryptedColumn = {
    table,
    column,
    key,
    bindingTable,
    bindingColumn,
    tenantColumn,
    id,
    blindIndex: options.blindIndex
      ? {
          column: options.blindIndex,
          key: propertyOf(table, options.blindIndex),
          normalize: options.normalize as Normalizer,
        }
      : undefined,
  };
  declarations.set(column, entry);
  return entry;
}

/** The declaration of `column`, or an error naming it. */
export function encryptedColumn(column: PgColumn): EncryptedColumn {
  const entry = declarations.get(column);
  if (!entry) {
    throw new Error(
      `${getTableName(getColumnTable(column))}.${column.name} is not declared encrypted (encrypted()).`,
    );
  }
  return entry;
}

/** Lists the encrypted columns a provider owns; found by EncryptionService. */
export const EncryptedColumns = DiscoveryService.createDecorator<PgColumn[]>();
