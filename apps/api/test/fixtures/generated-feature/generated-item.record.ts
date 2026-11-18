import { field } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';

/**
 * Generated items: their fields, recycle bin and units, declared once. The
 * table, schemas, list, permissions, policy, store and presenter are
 * derived from it (modules/records). Change a field here, then run
 * drizzle-kit generate for its migration.
 */
export const GENERATED_ITEM = defineRecord({
  subject: 'GeneratedItem',
  path: 'generated-items',
  noun: 'generated item',
  table: 'generated_items',
  softDelete: true,
  unit: true,
  fields: {
    title: field.string().searchable(),
    body: field.text().optional().searchable(),
    status: field.enum(['draft', 'done']),
    amount: field.money().optional(),
    dueOn: field.date().optional(),
    code: field.string().unique().searchable(),
  },
});
