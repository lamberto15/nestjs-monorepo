import { recordTable } from '../../../src/modules/records/record.js';
// The test items' table first: a stage refers to one.
import '../test-items/test-items.tables.js';
import { TEST_STAGE } from './test-stage.record.js';

/** The test stages' table: the declaration's. */
export const testStages = recordTable(TEST_STAGE);
