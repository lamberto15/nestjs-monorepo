import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  type AnyPgColumnBuilder,
  index,
  type PgTableExtraConfigValue,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { organizationalUnits } from '../../iam/organization/organization.tables.js';
import {
  type AnyField,
  columnName,
  type Fields,
  tableHolds,
} from '../fields/field.js';
import { relate } from './record-relations.js';
import {
  type FieldColumns,
  fieldColumns,
  fieldExtras,
  fieldValues,
  fieldView,
  type FieldView,
  searchableFields,
} from '../fields/fields.js';
import { searchVector } from './full-text.js';

/**
 * A feature's records, declared once (`<item>.record.ts`): what the routes
 * call them, their table, their fields (modules/fields), their recycle bin
 * and units, and who gets them by default. The table, schemas, list,
 * permissions, policy, store and presenter are derived from it by the
 * functions of this module, called in the feature's own files (README.md).
 * No Nest here: drizzle-kit loads it through the tables.
 *
 * Add-ons (tags, comments, revisions…) are not named here: a feature turns
 * one on by importing its module (`TagsModule.forRecord(INVOICE)`).
 */
export interface RecordDeclaration<F extends Fields = Fields> {
  /** With `softDelete`: days a record stays in the recycle bin before it is purged (default SOFT_DELETE_RETENTION_DAYS). */
  recycleBinDays?: number;
  /** The permission subject, PascalCase: `Invoice`. Events are `invoice.created`… */
  subject: string;
  /** The collection's path under /v1, kebab-case: `invoices`. */
  path: string;
  /** The record in prose: `invoice`. */
  noun: string;
  /** The SQL table: `invoices`. */
  table: string;
  /**
   * The field people name a record by outside the app (`code`, an invoice
   * number): exports write it instead of the id, a reference to the record
   * is written as it, and imports find records by it. A unique field
   * (`.unique()`), or one unique within `keyWithin`. Without one, the id
   * (recordKeyOf()). record-keys.ts reads keys and finds records by them.
   */
  key?: keyof F & string;
  /**
   * The required reference `key` is unique within (a product's `code`
   * within its bank, `clientId`): the table gets that unique index, and
   * the key is written as a path of its parents' keys, `QWERT/HL`.
   */
  keyWithin?: keyof F & string;
  /** Deleted records go to a recycle bin (`deletedAt`), restorable. */
  softDelete: boolean;
  /**
   * Records carry their creator's organizational unit (`unitId`, read by
   * the unit conditions): set when the creator is a current member of
   * exactly one unit.
   */
  unit: boolean;
  /**
   * `'own'`: every API client creates, reads, changes and deletes the
   * records it created. Unset or `false`: a client reaches them only
   * through a role an administrator grants it.
   */
  clientAccess?: false | 'own';
  /**
   * The seed roles' grants: `standard` (the default) is editors their own,
   * unit leads their units' (with `unit`), viewers every record; `none`:
   * only administrators until someone grants it.
   */
  grants?: 'standard' | 'none';
  /**
   * The create route's `Idempotency-Key`: `required`, `optional` or
   * `off`. Unset: the deployment's IDEMPOTENCY.
   */
  idempotency?: 'required' | 'optional' | 'off';
  /** The Swagger tag of its routes (default: `path`). */
  apiTag?: string;
  /**
   * Views besides the table, on the same list (GET /v1/lists/{subject}): a
   * board of an enum field, a calendar of date fields, a timeline.
   */
  views?: RecordViews;
  fields: F;
}

/** The board, calendar and timeline a record's list offers (fields of its list). */
export interface RecordViews {
  board?: { field: string; readOnly?: boolean };
  calendar?: { fields: readonly string[]; readOnly?: boolean };
  timeline?: { start: string; end: string };
}

const SUBJECT = /^[A-Z][A-Za-z0-9]*$/;
const PATH = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A record's declaration, typed and checked: `export const INVOICE = defineRecord({ … })`. */
export function defineRecord<
  const F extends Fields,
  const D extends RecordDeclaration<F>,
>(declaration: D & { fields: F }): D {
  if (!SUBJECT.test(declaration.subject)) {
    throw new Error(
      `"${declaration.subject}": a record's subject is PascalCase (Invoice).`,
    );
  }
  if (!PATH.test(declaration.path)) {
    throw new Error(
      `${declaration.subject}: "${declaration.path}" is no path: kebab-case (purchase-orders).`,
    );
  }
  if (declaration.key) {
    const key = declaration.fields[declaration.key] as AnyField | undefined;
    const within = declaration.keyWithin
      ? (declaration.fields[declaration.keyWithin] as AnyField | undefined)
      : undefined;
    if (!key) {
      throw new Error(
        `${declaration.subject}: its key "${declaration.key}" is none of its fields.`,
      );
    }
    if (declaration.keyWithin) {
      if (within?.kind !== 'ref' || within.options.optional) {
        throw new Error(
          `${declaration.subject}: keyWithin "${declaration.keyWithin}" must be a required reference field.`,
        );
      }
    } else if (!key.options.unique) {
      throw new Error(
        `${declaration.subject}: its key "${declaration.key}" must be a unique field (.unique()), or unique within a reference (keyWithin).`,
      );
    }
  } else if (declaration.keyWithin) {
    throw new Error(`${declaration.subject}: keyWithin needs a key.`);
  }
  for (const name of Object.keys(declaration.fields)) {
    if (RESERVED.includes(name)) {
      throw new Error(
        `${declaration.subject}: "${name}" is a column every record has: name the field otherwise.`,
      );
    }
  }
  // Nest hashes a dynamic module's metadata (forFeature(), an add-on's
  // forRecord()): the subject names the declaration, which holds tables and schemas.
  Object.defineProperty(declaration, 'toJSON', {
    value: () => `record:${declaration.subject}`,
  });
  return declaration;
}

/** The columns the engine adds: no field may take their names. */
const RESERVED = [
  'id',
  'tenantId',
  'ownerId',
  'unitId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
  'search',
  'can',
];

/** `Invoice` → `invoice`: event types, audit actions, error codes. */
export const recordKey = (declaration: RecordDeclaration) =>
  declaration.subject[0]!.toLowerCase() + declaration.subject.slice(1);

/** `a note`, `an invoice`. */
export const aNoun = (declaration: RecordDeclaration) =>
  `${/^[aeiou]/i.test(declaration.noun) ? 'an' : 'a'} ${declaration.noun}`;

/** The record's text fields people search, when it has any (`.searchable()`). */
export const searchedFields = (declaration: RecordDeclaration) =>
  searchableFields(declaration.fields);

const base = () => ({
  id: uuidPk(),
  /** Who created it: `user:<id>`, `client:<id>` or `system:<job>`. */
  ownerId: text('owner_id').notNull(),
});
const unitColumns = () => ({ unitId: uuid('unit_id') });
const binColumns = () => ({
  /** Set while it is in the recycle bin. */
  deletedAt: at('deleted_at'),
  deletedBy: text('deleted_by'),
});
const searchColumns = () => ({ search: searchVector('search', []) });
type Empty = Record<never, never>;

/** The columns of a record's table, as its declaration says. */
export type RecordColumns<
  D extends RecordDeclaration,
  X extends Record<string, AnyPgColumnBuilder> = Empty,
> = ReturnType<typeof base> &
  (D['unit'] extends true ? ReturnType<typeof unitColumns> : Empty) &
  FieldColumns<D['fields']> &
  X &
  ReturnType<typeof timestamps> &
  (D['softDelete'] extends true ? ReturnType<typeof binColumns> : Empty) &
  Partial<ReturnType<typeof searchColumns>>;

/**
 * A record's table (a tenant table, `{ referenced: true }`): id, owner,
 * (unit,) the fields, `columns` (what an add-on keeps on the row, spread
 * from its exported helper), timestamps, (the recycle bin,) and with
 * `.searchable()` fields a search vector; the owner's index, the fields'
 * unique indexes and keys, the unit's key. `extras` adds indexes of the
 * feature's own.
 *
 * ```ts
 * export const invoices = recordTable(INVOICE);
 * ```
 */
export function recordTable<
  const D extends RecordDeclaration,
  X extends Record<string, AnyPgColumnBuilder> = Empty,
>(
  declaration: D,
  {
    columns,
    extras,
  }: {
    columns?: X;
    extras?: (table: Record<string, AnyPgColumn>) => PgTableExtraConfigValue[];
  } = {},
) {
  const name = declaration.table;
  const searched = searchedFields(declaration).map(columnName);
  const all = {
    ...base(),
    ...(declaration.unit && unitColumns()),
    ...fieldColumns(declaration.fields),
    ...columns,
    ...timestamps(),
    ...(declaration.softDelete && binColumns()),
    ...(searched.length > 0 && { search: searchVector('search', searched) }),
  } as unknown as RecordColumns<D, X>;
  const table = tenantTable(
    name as D['table'],
    all,
    (built) => {
      // The columns by name: their types vary with the declaration.
      const t = built as unknown as Record<string, AnyPgColumn> &
        Parameters<typeof fieldExtras>[1];
      return [
        index(`${name}_owner_id_idx`).on(t.ownerId!),
        ...(declaration.softDelete
          ? [index(`${name}_deleted_at_idx`).on(t.deletedAt!)]
          : []),
        ...(searched.length > 0
          ? [index(`${name}_search_idx`).using('gin', t.search!)]
          : []),
        ...fieldExtras(name, t, declaration.fields, declaration.softDelete),
        ...(declaration.key && declaration.keyWithin
          ? [
              // The key is unique within its parent (live rows, as a unique field's).
              ((unique) =>
                declaration.softDelete
                  ? unique.where(sql`deleted_at is null`)
                  : unique)(
                uniqueIndex(`${name}_key_idx`).on(
                  t.tenantId!,
                  t[declaration.keyWithin]!,
                  t[declaration.key]!,
                ),
              ),
            ]
          : []),
        ...(declaration.unit
          ? [
              // As a reference field's (fieldExtras): a unit-scoped list
              // (`unit_id in …`, newest first) is a range of it, and the
              // key's check when a unit is deleted uses it.
              index(`${name}_unit_id_idx`).on(
                t.tenantId!,
                t.unitId!,
                t.id!.desc().nullsFirst(),
              ),
              // A unit with records can't be deleted.
              tenantReference(
                `${name}_unit_fk`,
                [t.tenantId!, t.unitId!],
                [organizationalUnits.tenantId, organizationalUnits.id],
                'restrict',
              ),
            ]
          : []),
        ...(extras?.(t) ?? []),
      ];
    },
    { referenced: true },
  );
  tableHolds(table, declaration.subject);
  relate(declaration, table as unknown as RecordTable);
  return table;
}

/** A record's table, as the engine reads it: its columns by property name. */
export type RecordTable = Parameters<typeof tableHolds>[0] &
  Record<string, AnyPgColumn> & { id: AnyPgColumn; ownerId: AnyPgColumn };

/** A row of a record's table, as the engine handles it. */
export type RecordRow = { id: string; ownerId: string } & Record<
  string,
  unknown
>;

/** A body's values as the table's columns (money, datetimes mapped): only what was sent. */
export const recordValues = (
  declaration: RecordDeclaration,
  dto: Record<string, unknown>,
) => fieldValues(declaration.fields, dto);

/**
 * A record as the API shows it (and events and the audit log carry it):
 * money as objects, without its tenant (the request's own) or search vector.
 */
export function recordView<
  D extends RecordDeclaration,
  Row extends Record<string, unknown>,
>(
  declaration: D,
  row: Row,
): Omit<FieldView<D['fields'], Row>, 'search' | 'tenantId'> {
  const {
    search: _search,
    tenantId: _tenantId,
    ...view
  } = fieldView(declaration.fields, row) as Record<string, unknown>;
  return view as Omit<FieldView<D['fields'], Row>, 'search' | 'tenantId'>;
}
