import { field, type Referenced } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';
import { recordTableOf } from '../../../src/modules/records/record-relations.js';
import { TEST_ITEM } from '../test-items/test-item.record.js';

/**
 * Referenced items: a record whose own `reference` a naming series fills
 * when a create leaves it empty (`forRecord(…, { field })`); one typed in
 * is kept. `region` is what a pattern may print; `itemId` a test item
 * whose fields a series reads (`item_code`), as a company's code; `label`
 * is unique within it (`unique({ within })`).
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
    itemId: field.ref((): Referenced => recordTableOf(TEST_ITEM)).optional(),
    label: field.string().optional().unique({ within: 'itemId' }),
  },
});
