import { Policy } from '@nestjs/authorization';
import { RecordPolicy } from '../../../src/modules/records/record.policy.js';

/**
 * Who may do what with a test item: each action checked against the row
 * (RecordPolicy). Business logic: an ability of the feature's goes here.
 */
@Policy()
export class TestItemPolicy extends RecordPolicy {}
