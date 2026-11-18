import { recordTable } from '../../../src/modules/records/record.js';
import { numberColumns } from '../../../src/modules/sequences/sequences.record.js';
import { NUMBERED_ITEM } from './numbered-item.record.js';

/** The numbered items' table: the declaration's, with the number column. */
export const numberedItems = recordTable(NUMBERED_ITEM, {
  columns: numberColumns(),
});
