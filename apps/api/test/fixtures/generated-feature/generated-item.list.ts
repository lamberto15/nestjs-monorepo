import { recordList } from '../../../src/modules/records/record.list.js';
import { GENERATED_ITEM } from './generated-item.record.js';
import { generatedItems } from './generated-items.tables.js';

/** What GET /generated-items is filtered, sorted and narrowed by: from generated-item.record.ts. */
export const GENERATED_ITEM_LIST = recordList(GENERATED_ITEM, generatedItems);
