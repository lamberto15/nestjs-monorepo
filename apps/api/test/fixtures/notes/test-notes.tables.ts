import { recordTable } from '../../../src/modules/records/record.js';
// The test items' table first: a note refers to one.
import '../test-items/test-items.tables.js';
import { TEST_NOTE } from './test-note.record.js';

/** The test notes' table: the declaration's. */
export const testNotes = recordTable(TEST_NOTE);
