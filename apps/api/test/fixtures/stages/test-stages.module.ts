import { Module } from '@nestjs/common';
import { Policy } from '@nestjs/authorization';
import { AccessModule } from '../../../src/iam/access/access.module.js';
import { DataTransferModule } from '../../../src/modules/data-transfer/data-transfer.module.js';
import { recordList } from '../../../src/modules/records/record.list.js';
import { recordPermissions } from '../../../src/modules/records/record.permissions.js';
import { RecordPolicy } from '../../../src/modules/records/record.policy.js';
import { recordSchemas } from '../../../src/modules/records/record.schemas.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import { TEST_STAGE } from './test-stage.record.js';
import { testStages } from './test-stages.tables.js';

@Policy()
class TestStagePolicy extends RecordPolicy {}

/** Test stages, exported and imported (no routes of their own). */
@Module({
  imports: [
    AccessModule.forFeature(recordPermissions(TEST_STAGE, testStages)),
    RecordsModule.forFeature(TEST_STAGE, {
      table: testStages,
      list: recordList(TEST_STAGE, testStages),
      schemas: recordSchemas(TEST_STAGE),
      policy: TestStagePolicy,
    }),
    DataTransferModule.forRecord(TEST_STAGE),
  ],
  providers: [TestStagePolicy],
})
export class TestStagesModule {}
