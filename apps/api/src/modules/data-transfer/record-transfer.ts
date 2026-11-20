import type { z } from 'zod';
import type { AnyField } from '../fields/field.js';
import { fieldSchemas } from '../fields/fields.js';
import type { RecordDeclaration } from '../records/record.js';
import type { RecordRegistration } from '../records/records.service.js';
import type { TransferColumn } from './data-transfer.types.js';

/**
 * How a record goes into a file and comes back, from its declaration: the
 * columns of an export (what its list shows, as the API shows it), the row
 * schema of an import (its create body), the columns a matched import may
 * find a record by, and a file's text cells as that body takes them.
 */

/** A shown value as text a person reads: a tag list as `Urgent, Q3`, a money object as `12.50 EUR`. */
function shownValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item: unknown) =>
        item && typeof item === 'object' && 'name' in item
          ? String((item as { name: unknown }).name)
          : typeof item === 'object'
            ? JSON.stringify(item)
            : String(item as string | number | boolean),
      )
      .join(', ');
  }
  return value;
}

const money = (value: unknown) => {
  const amount = value as { amount: string; currency: string } | null;
  return amount ? `${amount.amount} ${amount.currency}` : '';
};

/**
 * The columns of an export: the id, every field (money as `12.50 EUR`,
 * date-times in the reader's zone), what the record's add-ons show
 * (`number`, `tags`), the owner and the creation time.
 */
export function exportColumns(
  registration: RecordRegistration,
): TransferColumn[] {
  const { fields } = registration.declaration;
  const shows = registration.extensions.flatMap((hooks) => hooks.shows ?? []);
  return [
    { key: 'id' },
    ...Object.entries(fields).map(([name, f]): TransferColumn =>
      f.kind === 'money'
        ? { key: name, value: (row) => money(row[name]) }
        : f.kind === 'datetime'
          ? { key: name, type: 'datetime' }
          : f.kind === 'date'
            ? { key: name, type: 'date' }
            : { key: name },
    ),
    ...shows.map((key): TransferColumn => ({
      key,
      value: (row) => shownValue(row[key]),
    })),
    { key: 'ownerId', header: 'owner' },
    { key: 'createdAt', type: 'datetime' },
  ];
}

/** An import row: the record's create body (its fields, read-only ones left out). */
export const importSchema = (declaration: RecordDeclaration): z.ZodObject =>
  fieldSchemas(declaration.fields).create as unknown as z.ZodObject;

/**
 * The columns a matched import may find a record by: its id, and its unique
 * fields (not one unique only within another field: alone it finds several).
 */
export const matchKeys = (declaration: RecordDeclaration) => [
  'id',
  ...Object.entries(declaration.fields)
    .filter(
      ([, f]) =>
        f.options.unique && !f.options.uniqueWithin && !f.options.readOnly,
    )
    .map(([name]) => name),
];

const INTEGER = /^-?\d+$/;
const MONEY = /^(-?\d+(?:\.\d+)?)\s+([A-Za-z]{3})$/;

/** One cell's text as the field's body takes it; left as it is when it doesn't fit (the schema says why). */
function cellValue(f: AnyField, text: string): unknown {
  switch (f.kind) {
    case 'int':
      return INTEGER.test(text) ? Number(text) : text;
    case 'bool':
      return /^true$/i.test(text) ? true : /^false$/i.test(text) ? false : text;
    case 'money': {
      const match = MONEY.exec(text);
      return match
        ? { amount: match[1]!, currency: match[2]!.toUpperCase() }
        : text;
    }
    case 'json':
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    default:
      return text;
  }
}

/**
 * A file's row as the record's create body: each field's cell converted
 * (files bring text), an empty cell left out (it sets nothing, so it needs
 * no permission), and what is no field (`owner`, `createdAt` of an
 * export) dropped.
 */
export function bodyOf(
  declaration: RecordDeclaration,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(declaration.fields)) {
    const value = record[name];
    if (value === undefined || value === '' || f.options.readOnly) continue;
    body[name] = typeof value === 'string' ? cellValue(f, value) : value;
  }
  return body;
}
