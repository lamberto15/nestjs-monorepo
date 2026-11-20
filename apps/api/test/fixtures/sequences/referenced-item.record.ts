import { field } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';

/**
 * Referenced items: a record whose own `reference` a naming series fills
 * when a create leaves it empty (`forRecord(…, { field })`); one typed in
 * is kept. `region` is what a pattern may print.
 */
export const REFERENCED_ITEM = defineRecord({
  subject: 'ReferencedItem',
  path: 'referenced-items',
  noun: 'referenced item',
  table: 'test_referenced_items',
  softDelete: false,
  unit: false,
  fields: {
    reference: field.string().optional().unique(),
    region: field.string().optional(),
  },
});
