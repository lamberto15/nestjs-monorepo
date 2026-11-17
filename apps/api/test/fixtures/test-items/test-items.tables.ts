import { recordTable } from '../../../src/modules/records/record.js';
import { markColumns } from './marks/marks.columns.js';
import { TEST_ITEM } from './test-item.record.js';

/** Test items: the table test-item.record.ts declares, with the column the marks add-on adds. */
export const testItems = recordTable(TEST_ITEM, { columns: markColumns() });
