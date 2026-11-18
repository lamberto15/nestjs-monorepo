import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { JobsModule } from '../../core/jobs/jobs.module.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { PersonalDataModule } from '../../iam/personal-data/personal-data.module.js';
import { AccountExportsController } from './account-exports.controller.js';
import {
  ACCOUNT_EXPORTS,
  AccountExportProcessor,
  AccountExports,
} from './account-exports.service.js';
import { AccountExportFilesSweep } from './transfer-files.sweep.js';

/**
 * `POST /v1/account/export` and `GET /v1/account/exports`: a person's copy
 * of their data, written on the `account-exports` queue from every module's
 * `@PersonalData()` section, and the nightly sweep of the files past
 * TRANSFER_KEPT_MS. Needs QueuesModule, StorageModule, SharedLocksModule and
 * the app's PersonalDataModule.
 */
@Module({
  imports: [
    BullModule.registerQueue({
      name: ACCOUNT_EXPORTS,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    AuditModule,
    JobsModule,
    PersonalDataModule,
  ],
  controllers: [AccountExportsController],
  providers: [AccountExports, AccountExportProcessor, AccountExportFilesSweep],
})
export class AccountExportsModule {}
