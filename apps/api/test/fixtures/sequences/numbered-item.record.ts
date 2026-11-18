import { field } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';

/**
 * Numbered items: a small record of the sequences add-on's own tests (the
 * test items have no column for a number). `region` is what a naming
 * series may print or test.
 */
export const NUMBERED_ITEM = defineRecord({
  subject: 'NumberedItem',
  path: 'numbered-items',
  noun: 'numbered item',
  table: 'test_numbered_items',
  softDelete: false,
  unit: false,
  fields: {
    title: field.string(),
    region: field.string().optional(),
    code: field.string().optional().unique(),
  },
});
