import {
  type AnyPgColumn,
  type AnyPgTable,
  type AnyPgColumnBuilder,
  foreignKey,
  type PgBuildExtraConfigColumns,
  pgTable,
  type PgTableExtraConfigValue,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';
import { tenants } from './tenancy.tables.js';
import { isolation } from './tenant-isolation.js';
import { currentTenantScope, requireTenantId } from './tenant-scope.js';

/**
 * The `tenant_id` every tenant table gets: NOT NULL, no database default (a
 * raw insert must name its tenant), referencing `tenants`. An insert that
 * leaves it out gets the context's tenant, or a TenantScopeMissingError
 * without one; the wall checks the value is the context's.
 */
const tenantColumn = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' })
    .$defaultFn(() => requireTenantId('An insert into a tenant table'));

/**
 * The `tenant_id` of a tenant table with rows of no tenant (`nullRows`):
 * an insert that leaves it out gets the context's tenant, or null without
 * one.
 */
const nullableTenantColumn = () =>
  uuid('tenant_id')
    .references(() => tenants.id, { onDelete: 'cascade' })
    // Null (no tenant) is what the column allows; Drizzle's type wants a value.
    .$defaultFn(() => currentTenantScope()?.tenantId as string);

/**
 * The `tenant_id` of a global table that names a tenant: required on
 * every insert (no default from the context: such rows are written for a
 * tenant named on purpose, often outside its scope).
 */
const namedTenantColumn = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' });

type TenantColumns<TColumns, TNullRows = undefined> = TColumns & {
  tenantId: TNullRows extends 'outside'
    ? ReturnType<typeof nullableTenantColumn>
    : ReturnType<typeof tenantColumn>;
};

/** A table that names a tenant: how `tenantTable()` and `globalTable()` made it. */
export interface TenantTableEntry {
  readonly name: string;
  readonly table: AnyPgTable;
  readonly kind: 'tenant' | 'global';
}

const declared = new Map<string, TenantTableEntry>();

/** Remembers a table as it is made (by name: a table made twice is one). */
function registered<T extends AnyPgTable>(
  kind: TenantTableEntry['kind'],
  table: T,
): T {
  const name = getTableName(table);
  declared.set(name, { name, table, kind });
  return table;
}

/**
 * Every table declared with `tenantTable()` or `globalTable()` so far, by
 * name: what a tenant's export walks, with no list to keep. A table is
 * there once its file has been imported, so the app (which imports every
 * module's tables) has them all; a test that boots a few has those.
 */
export function tenantTables(): readonly TenantTableEntry[] {
  return [...declared.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A tenant table: a `pgTable` with a `tenantId` column added and the wall
 * of the isolation mode declared with it, so `pnpm db:generate` emits both.
 * Its rows are only ever seen and written in their tenant's scope.
 * `referenced: true` for a table that other tenant tables point at
 * (tenantReference()): it adds the unique `(tenant_id, id)` their keys need.
 * Uniques are per tenant: lead them with `t.tenantId`.
 *
 * `nullRows: 'outside'` for a table that also keeps rows of no tenant (an
 * account's own entries in the audit log, written before any tenant is
 * chosen): `tenant_id` may be null, and those rows are read and written
 * only by work outside every tenant, never by a tenant's.
 *
 * ```ts
 * export const invoices = tenantTable('invoices', {
 *   id: uuidPk(),
 *   customerId: uuid('customer_id').notNull(),
 *   number: text('number').notNull(),
 *   ...timestamps(),
 * }, (t) => [
 *   uniqueIndex('invoices_number_idx').on(t.tenantId, t.number),
 *   tenantReference('invoices_customer_fk', [t.tenantId, t.customerId], [customers.tenantId, customers.id]),
 * ]);
 * ```
 */
export function tenantTable<
  TName extends string,
  TColumns extends Record<string, AnyPgColumnBuilder>,
  TNullRows extends 'outside' | undefined = undefined,
>(
  name: TName,
  columns: TColumns,
  extraConfig?: (
    self: PgBuildExtraConfigColumns<TenantColumns<TColumns, TNullRows>>,
  ) => PgTableExtraConfigValue[],
  {
    referenced = false,
    nullRows,
  }: { referenced?: boolean; nullRows?: TNullRows } = {},
) {
  return registered(
    'tenant',
    pgTable(
      name,
      {
        ...columns,
        tenantId: nullRows ? nullableTenantColumn() : tenantColumn(),
      } as TenantColumns<TColumns, TNullRows>,
      (t) => {
        const self = t as unknown as {
          tenantId: AnyPgColumn;
          id?: AnyPgColumn;
        };
        if (referenced && !self.id) {
          throw new Error(
            `${name}: a referenced tenant table needs an id column.`,
          );
        }
        return [
          ...isolation.tableWall(
            name,
            self.tenantId,
            nullRows ? 'tenant-or-none' : 'tenant',
          ),
          ...(referenced && self.id
            ? [unique(`${name}_tenant_id_id_key`).on(self.tenantId, self.id)]
            : []),
          ...(extraConfig?.(t) ?? []),
        ];
      },
    ),
  );
}

/**
 * A global table whose rows name a tenant: read before the request has a
 * tenant, to find it (which tenants a user belongs to, whose an API key
 * is). Its rows are every context's: code reading them for a tenant
 * filters by `tenantId` itself, and an insert names the tenant. The
 * declaration (a `<table>_global` policy, no wall) is what lets the check
 * at migrate tell it from a tenant table that lost its wall.
 *
 * ```ts
 * export const memberships = globalTable('memberships', {
 *   userId: uuid('user_id').notNull(),
 * }, (t) => [primaryKey({ columns: [t.tenantId, t.userId] })]);
 * ```
 */
export function globalTable<
  TName extends string,
  TColumns extends Record<string, AnyPgColumnBuilder>,
>(
  name: TName,
  columns: TColumns,
  extraConfig?: (
    self: PgBuildExtraConfigColumns<
      TColumns & { tenantId: ReturnType<typeof namedTenantColumn> }
    >,
  ) => PgTableExtraConfigValue[],
) {
  return registered(
    'global',
    pgTable(
      name,
      { ...columns, tenantId: namedTenantColumn() } as TColumns & {
        tenantId: ReturnType<typeof namedTenantColumn>;
      },
      (t) => [
        ...isolation.tableWall(
          name,
          (t as unknown as { tenantId: AnyPgColumn }).tenantId,
          'global',
        ),
        ...(extraConfig?.(t) ?? []),
      ],
    ),
  );
}

/**
 * A key from one tenant table to another, within the tenant:
 * `(tenant_id, x_id)` → `(tenant_id, id)`. PostgreSQL checks a key as the
 * tables' owner, past the wall, so a plain `x_id → id` could point at
 * another tenant's row; this one can't. The referenced table is declared
 * `{ referenced: true }`. No `set null`: it would empty `tenant_id` too.
 */
export function tenantReference(
  name: string,
  columns: [tenantId: AnyPgColumn, column: AnyPgColumn],
  foreign: [tenantId: AnyPgColumn, id: AnyPgColumn],
  onDelete: 'cascade' | 'restrict' | 'no action' = 'cascade',
) {
  return foreignKey({ name, columns, foreignColumns: foreign }).onDelete(
    onDelete,
  );
}
