import { recordTable } from '../../../src/modules/records/record.js';
// The test items' table first: a referenced item refers to one.
import '../test-items/test-items.tables.js';
import { REFERENCED_ITEM } from './referenced-item.record.js';

/** The referenced items' table: the declaration's, no number column. */
export const referencedItems = recordTable(REFERENCED_ITEM);
