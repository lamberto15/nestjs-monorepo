import { recordPermissions } from '../../../src/modules/records/record.permissions.js';
import { TEST_ITEM } from './test-item.record.js';
import { testItems } from './test-items.tables.js';

/**
 * What can be done with test items: the standard actions, conditions and
 * seed roles' grants from test-item.record.ts, and the feature's own:
 * `body` granted field by field.
 */
export const TEST_ITEM_PERMISSIONS = recordPermissions(TEST_ITEM, testItems, {
  fields: { body: {} },
});
