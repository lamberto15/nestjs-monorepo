import { and, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { FilterField, FilterOp } from '../../core/http/list-query.js';
import type { RecordTable } from '../records/record.js';
import type { CustomFieldDefinition } from './custom-field.types.js';
import { CUSTOM_KEY_PATTERN } from './custom-field.values.js';
import { customFieldValues as v } from './custom-fields.tables.js';

/** Text-like custom values: compared as text, searched with the text operators. */
const TEXT_FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'in',
  'notIn',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isNull',
];
const ORDERED_FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'isNull',
];

/** Where a record's custom values are: the subject, its table, a query builder for the subqueries. */
export interface CustomValuesSource {
  db: Database;
  subject: string;
  table: RecordTable;
}

/**
 * A subject's active custom fields as list fields (core/http/list-query.ts),
 * to `extend()` the record's list with: `custom.<key>` is then filtered
 * (flat or in `filter`), sorted and picked with `fields=` like a declared
 * field. The values live in custom_field_values, so each condition is a
 * subquery on it:
 *
 * - `eq`, `in` and `isNull` are `id in (records whose values contain …)`,
 *   on its GIN index (`@>`, `?`);
 * - `ne`, `notIn`, ranges, text operators and sorts read the record's
 *   value, typed, per row (a correlated subquery): no index serves them.
 * - Filters only on fields marked filterable, sorts only on sortable ones;
 *   a multiSelect takes `in` (holds any of) and `isNull`; every active
 *   field can be picked with `fields=custom.<key>`.
 */
export function customFilterFields(
  definitions: readonly CustomFieldDefinition[],
  { db, subject, table }: CustomValuesSource,
): { fields: Record<string, FilterField>; select: string[] } {
  const ofSubject = eq(v.subject, subject);
  /** Records whose values meet `condition`. */
  const holding = (condition: SQL) =>
    inArray(
      table.id,
      db.select({ id: v.recordId }).from(v).where(and(ofSubject, condition)),
    );
  const fields: Record<string, FilterField> = {};
  const select: string[] = [];
  for (const field of definitions) {
    if (!field.active) continue;
    if (!CUSTOM_KEY_PATTERN.test(field.key)) {
      throw new Error(`Invalid custom field key: ${field.key}`);
    }
    const name = `custom.${field.key}`;
    select.push(name);
    if (!field.filterable && !field.sortable) continue;
    const key = sql`${field.key}::text`;
    // The record's value as text (null without one): a correlated subquery.
    const text = sql`(${db
      .select({ value: sql`${v.values} ->> ${key}` })
      .from(v)
      .where(and(ofSubject, eq(v.recordId, table.id)))})`;
    // Equality as containment, on the GIN index: values are never JSON null, so it is `=`.
    const contains = (value: unknown) =>
      holding(
        sql`${v.values} @> ${JSON.stringify({ [field.key]: value })}::jsonb`,
      );
    const has = holding(sql`${v.values} ? ${key}`);
    const isNull = (value: unknown): SQL =>
      value
        ? notInArray(
            table.id,
            db
              .select({ id: v.recordId })
              .from(v)
              .where(and(ofSubject, sql`${v.values} ? ${key}`)),
          )
        : has;
    const equality = {
      eq: contains,
      in: (values: unknown) =>
        or(...(values as unknown[]).map(contains)) as SQL,
      isNull,
    };
    const ops = (all: readonly FilterOp[]) => (field.filterable ? all : []);
    switch (field.type) {
      case 'number': {
        const number = sql`(${text})::numeric`;
        fields[name] = {
          column: number,
          type: 'number',
          ops: ops([...ORDERED_FILTER_OPS, 'in', 'notIn']),
          sortable: field.sortable,
          conditions: equality,
          // numeric comes back as text: the cursor needs the number.
          select: number.mapWith(Number),
        };
        break;
      }
      case 'date':
        fields[name] = {
          column: sql`(${text})::date`,
          type: 'date',
          ops: ops(ORDERED_FILTER_OPS),
          sortable: field.sortable,
          // Stored as YYYY-MM-DD: text equality is date equality.
          conditions: { eq: contains, isNull },
          // As stored: node-postgres would turn a date into a local-midnight Date.
          select: text,
        };
        break;
      case 'boolean':
        fields[name] = {
          column: sql`(${text})::boolean`,
          type: 'boolean',
          ops: ops(['eq', 'ne', 'isNull']),
          sortable: field.sortable,
          conditions: { eq: contains, isNull },
        };
        break;
      case 'select':
      case 'multiSelect': {
        const choices = (field.options ?? []).map((option) => option.value);
        if (!choices.length) continue;
        const values = choices as [string, ...string[]];
        if (field.type === 'select') {
          fields[name] = {
            column: text,
            type: 'enum',
            values,
            ops: ops(['eq', 'ne', 'in', 'notIn', 'isNull']),
            sortable: field.sortable,
            conditions: equality,
          };
          break;
        }
        fields[name] = {
          column: text,
          type: 'enum',
          values,
          ops: ops(['in', 'isNull']),
          sortable: false, // an array has no useful order
          conditions: {
            // Holds any of them: containment of a one-element array, on the GIN index.
            in: (items) =>
              or(...(items as string[]).map((item) => contains([item]))) as SQL,
            isNull,
          },
        };
        break;
      }
      default:
        fields[name] = {
          column: text,
          type: 'string',
          ops: ops(TEXT_FILTER_OPS),
          sortable: field.sortable,
          conditions: equality,
        };
    }
  }
  return { fields, select };
}
