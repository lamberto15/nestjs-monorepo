import {
  boolean,
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';
import type {
  CustomFieldOption,
  CustomFieldType,
  CustomFieldValidation,
} from './custom-field.types.js';

/**
 * The fields a tenant's administrators added to a record's subject at
 * runtime (`TestItem`). A field is never deleted, only deactivated, so its
 * key can't be reused for another type while records hold old values.
 */
export const customFieldDefinitions = tenantTable(
  'custom_field_definitions',
  {
    id: uuidPk(),
    /** The record's permission subject: `Invoice`. */
    subject: text('subject').notNull(),
    /** The JSON key of the value (a slug): set once, never changed. */
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description'),
    type: text('type').$type<CustomFieldType>().notNull(),
    /** The choices of `select` and `multiSelect`. */
    options: jsonb('options').$type<CustomFieldOption[]>(),
    /** Required on create (a default fills it when it's left out). */
    required: boolean('required').notNull().default(false),
    /** Filled in on create when the value is left out. */
    defaultValue: jsonb('default_value'),
    validation: jsonb('validation').$type<CustomFieldValidation>(),
    /** The order fields are shown in (forms, tables). */
    position: integer('position').notNull().default(0),
    /** May lists filter, and sort, by it. */
    filterable: boolean('filterable').notNull().default(false),
    sortable: boolean('sortable').notNull().default(false),
    /** Inactive: not accepted on writes, not shown; stored values are kept. */
    active: boolean('active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('custom_field_definitions_subject_key_idx').on(
      t.tenantId,
      t.subject,
      t.key,
    ),
    index('custom_field_definitions_subject_position_idx').on(
      t.tenantId,
      t.subject,
      t.position,
    ),
  ],
);

/**
 * A record's custom values, one row per record that holds any: JSON keyed
 * by the field's key, never a JSON null (removing a value removes its
 * key). Kept here rather than in a column of each record's table, so a
 * record takes custom fields by importing the add-on, with no column and
 * no migration of its own; the GIN index serves the list's equality and
 * presence filters (`@>`, `?`). The record's purge removes its row.
 */
export const customFieldValues = tenantTable(
  'custom_field_values',
  {
    id: uuidPk(),
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    values: jsonb('values').$type<Record<string, unknown>>().notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('custom_field_values_record_idx').on(
      t.tenantId,
      t.subject,
      t.recordId,
    ),
    index('custom_field_values_values_idx').using('gin', t.values),
  ],
);
