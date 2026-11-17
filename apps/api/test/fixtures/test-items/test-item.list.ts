import { recordList } from '../../../src/modules/records/record.list.js';
import { TEST_ITEM } from './test-item.record.js';
import { testItems } from './test-items.tables.js';

/** What GET /test-items is filtered, sorted and narrowed by: from test-item.record.ts. */
export const TEST_ITEM_LIST = recordList(TEST_ITEM, testItems);
