import { field, type Referenced } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';
import { recordTableOf } from '../../../src/modules/records/record-relations.js';
import { TEST_ITEM } from '../test-items/test-item.record.js';

/**
 * Test notes: a log on a test item, read through it (`readThrough`): whoever
 * may read the item reads its notes at `GET /v1/test-items/:itemId/test-notes`,
 * without a TestNote permission (`grants: 'none'`: no seed role has one).
 */
export const TEST_NOTE = defineRecord({
  subject: 'TestNote',
  path: 'test-notes',
  noun: 'test note',
  table: 'test_notes',
  softDelete: false,
  unit: false,
  grants: 'none',
  readThrough: 'itemId',
  fields: {
    itemId: field.ref((): Referenced => recordTableOf(TEST_ITEM)),
    body: field.string(),
  },
});
