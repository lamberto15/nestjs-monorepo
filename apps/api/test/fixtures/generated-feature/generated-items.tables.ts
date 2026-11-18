import { recordTable } from '../../../src/modules/records/record.js';
import { numberColumns } from '../../../src/modules/sequences/sequences.record.js';
import { GENERATED_ITEM } from './generated-item.record.js';

/** Generated items: the table generated-item.record.ts declares, with the columns its add-ons keep. */
export const generatedItems = recordTable(GENERATED_ITEM, {
  columns: numberColumns(),
});
