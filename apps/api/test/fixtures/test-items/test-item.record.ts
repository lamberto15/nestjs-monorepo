import { field, type Referenced } from '../../../src/modules/fields/field.js';
import { defineRecord } from '../../../src/modules/records/record.js';
import { recordTableOf } from '../../../src/modules/records/record-relations.js';

/**
 * Test items: the records the engine's tests run on (modules/records), in
 * the shape a generated feature has. Their fields, recycle bin and units,
 * declared once: the table, schemas, list, permissions, policy, store and
 * presenter are derived from it.
 */
export const TEST_ITEM = defineRecord({
  subject: 'TestItem',
  path: 'test-items',
  noun: 'test item',
  table: 'test_record_items',
  softDelete: true,
  unit: true,
  // The tests act as an API client on test items too.
  clientAccess: 'own',
  grants: 'standard',
  views: {
    board: { field: 'status' },
    calendar: { fields: ['publishedAt'] },
  },
  fields: {
    title: field.string().searchable(),
    body: field.text().optional().searchable(),
    publishedAt: field.datetime().optional(),
    code: field.string().optional().unique(),
    status: field.enum(['draft', 'done']).default('draft'),
    // Set by the service from the body (business logic), never by a request.
    words: field.int().optional().readOnly(),
    // Another test item: relations are tested on it. Deleting a parent its
    // live children refer to is refused (`restrict`, the default).
    parentId: field.ref((): Referenced => recordTableOf(TEST_ITEM)).optional(),
    // A link that stays while its test item is in the recycle bin.
    linkedId: field
      .ref((): Referenced => recordTableOf(TEST_ITEM))
      .optional()
      .onDelete('keep'),
  },
});
