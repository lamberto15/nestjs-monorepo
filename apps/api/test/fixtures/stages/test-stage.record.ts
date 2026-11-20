import { field, type Referenced } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';
import { recordTableOf } from '../../../src/modules/records/record-relations.js';
import { TEST_ITEM } from '../test-items/test-item.record.js';

/**
 * Test stages: a record whose code is unique within its test item only
 * (`unique({ within: 'itemId' })`), so files name one by a path of keys,
 * the item's code then its own (`P-1/OPEN`). `nextId` refers to another
 * stage: the reference such a path names.
 */
export const TEST_STAGE = defineRecord({
  subject: 'TestStage',
  path: 'test-stages',
  noun: 'test stage',
  table: 'test_stages',
  softDelete: false,
  unit: false,
  fields: {
    itemId: field.ref((): Referenced => recordTableOf(TEST_ITEM)),
    code: field.string().unique({ within: 'itemId' }),
    nextId: field.ref((): Referenced => recordTableOf(TEST_STAGE)).optional(),
  },
});
