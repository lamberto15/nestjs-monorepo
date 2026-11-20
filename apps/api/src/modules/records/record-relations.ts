import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { inArray } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  type AnyField,
  type OnDelete,
  type Referenced,
  referencedSubject,
} from '../fields/field.js';
import type { RecordDeclaration, RecordTable } from './record.js';

/**
 * A relationship between records, declared once: a `ref` field of one
 * record's declaration (`parentId: field.ref(() => recordTableOf(ITEM))`)
 * points at another's (one to many). The key, its index and the list
 * filter come from the field (modules/fields); from the relation
 * RecordStore derives the rest:
 *
 * - a write may only point at a live record the writer may read (422
 *   `reference_not_found`, the same for one in another tenant or none);
 * - deleting a record others refer to follows `.onDelete()`: `restrict`
 *   (the default) refuses it while live records refer to it (409
 *   `record_referenced`; for a required field those in the recycle bin
 *   too, as the key would refuse the purge); `keep` (optional fields only)
 *   lets it go to the recycle bin, the references kept. An optional
 *   reference empties when its record is deleted for good (`emptyReferences()`);
 * - restoring a record whose `restrict` reference points at one in the
 *   recycle bin is refused (409 `reference_deleted`): restore that one first;
 * - the referred record's related panels (`related` of GET /v1/lists/{subject})
 *   and `?include=<field without Id>` (`include=parent`: `{ id, title }`).
 *
 * Plain data, no Nest: recordTable() registers a record's relations when
 * its table is made; the same in every app of a process.
 */
export interface RecordRelation {
  /** The referring records' declaration. */
  from: RecordDeclaration;
  /** Their field holding the referred record's id: `parentId`. */
  field: string;
  table: RecordTable;
  column: AnyPgColumn;
  /** A required field (its key: `restrict`); an optional one empties when its record is purged. */
  required: boolean;
  onDelete: OnDelete;
  /** The subject referred to, read when asked: its table may load later. */
  target: () => string | undefined;
  targetTable: () => RecordTable;
}

const RELATIONS: RecordRelation[] = [];
const TABLES = new WeakMap<RecordDeclaration, RecordTable>();
const DECLARATIONS = new WeakMap<object, RecordDeclaration>();

/** The declaration of a record's table, as a `ref` field returns it; undefined for a table that holds no record. */
export const declarationOfTable = (table: object) => DECLARATIONS.get(table);

/** A record's table by its declaration, for a `ref` field to it (`() => recordTableOf(ITEM)`). */
export function recordTableOf(
  declaration: RecordDeclaration,
): Referenced & PgTable {
  const table = TABLES.get(declaration);
  if (!table) {
    throw new Error(
      `${declaration.subject} has no table yet: recordTable(${declaration.subject}) makes it.`,
    );
  }
  return table as unknown as Referenced & PgTable;
}

/** Registers a record's table and the relations of its `ref` fields (recordTable). */
export function relate(declaration: RecordDeclaration, table: RecordTable) {
  TABLES.set(declaration, table);
  DECLARATIONS.set(table, declaration);
  for (const [field, f] of Object.entries(declaration.fields) as [
    string,
    AnyField,
  ][]) {
    if (f.kind !== 'ref') continue;
    const onDelete = f.options.onDelete ?? 'restrict';
    if (onDelete === 'keep' && !f.options.optional) {
      throw new Error(
        `${declaration.subject}.${field}: onDelete('keep') needs an optional reference (one that empties when its record is purged).`,
      );
    }
    RELATIONS.push({
      from: declaration,
      field,
      table,
      column: table[field]!,
      required: !f.options.optional,
      onDelete,
      target: () => referencedSubject(f),
      targetTable: () => f.options.ref!() as unknown as RecordTable,
    });
  }
}

/** The relations that refer to `subject`'s records. */
export const relationsTo = (subject: string) =>
  RELATIONS.filter((relation) => relation.target() === subject);

/** The relations of `declaration`'s own `ref` fields. */
export const relationsFrom = (declaration: RecordDeclaration) =>
  RELATIONS.filter((relation) => relation.from === declaration);

/** `parentId` → `parent`: the `?include=` name of a reference. */
export const includeNameOf = (field: string) => field.replace(/Id$/, '');

/** The field a client names a record by: its first string field, or null. */
export const relationTitle = (declaration: RecordDeclaration) =>
  Object.entries(declaration.fields).find(
    ([, f]) => (f as AnyField).kind === 'string',
  )?.[0] ?? null;

/**
 * A record's parent: the reference field another of its fields is unique
 * within (`code: field.string().unique({ within: 'productId' })` makes
 * `productId` the parent), or null. Its title goes before the record's
 * (RecordTitles), and its key before the record's in files.
 */
export const recordParentField = (declaration: RecordDeclaration) => {
  const within = Object.values(declaration.fields)
    .map((field) => (field as AnyField).options.uniqueWithin)
    .find(
      (name): name is string =>
        typeof name === 'string' &&
        (declaration.fields[name] as AnyField | undefined)?.kind === 'ref',
    );
  return within ?? null;
};

/**
 * The field people name a record by in files (its key): its first unique
 * string or int field that is unique on its own (not `unique({ within })`),
 * a code or a number; null without one, and files keep its id.
 */
export const recordKeyField = (declaration: RecordDeclaration) =>
  Object.entries(declaration.fields).find(
    ([, field]) =>
      ['string', 'int'].includes((field as AnyField).kind) &&
      (field as AnyField).options.unique &&
      !(field as AnyField).options.uniqueWithin,
  )?.[0] ?? null;

/**
 * Empties the optional references to these records of `subject`, live or
 * in the recycle bin, just before they are deleted for good, in the
 * delete's transaction (the key is `no action`: a composite key's `set
 * null` would empty tenant_id too).
 */
export async function emptyReferences(
  db: Pick<Database, 'update'>,
  subject: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return;
  for (const relation of relationsTo(subject)) {
    if (relation.required) continue;
    await db
      .update(relation.table as unknown as PgTable)
      .set({ [relation.field]: null })
      .where(inArray(relation.column, [...ids]));
  }
}
