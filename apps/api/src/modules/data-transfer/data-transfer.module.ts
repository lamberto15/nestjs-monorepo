import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { JobsModule } from '../../core/jobs/jobs.module.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { RecordDeclaration } from '../records/record.js';
import { RECORD } from '../records/record-extension.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RecordsModule } from '../records/records.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { dataTransferConfig } from './data-transfer.config.js';
import { DataTransferController } from './data-transfer.controller.js';
import { DATA_TRANSFER_PERMISSIONS } from './data-transfer.permissions.js';
import { TransferExtension } from './data-transfer.extension.js';
import { DataTransferProcessor } from './data-transfer.processor.js';
import {
  DATA_TRANSFERS,
  DataTransferService,
} from './data-transfer.service.js';
import { DATA_TRANSFER_SETTINGS } from './data-transfer.settings.js';
import { ImportLimits } from './import-limits.js';
import { ImportMappingsController } from './import-mappings.controller.js';
import { ImportMappingsService } from './import-mappings.service.js';
import { ImportUpload } from './import-upload.interceptor.js';
import { PrincipalNow } from './principal-now.js';
import { RecordTransfers } from './record-transfers.js';
import { OperatorGuard } from '../../iam/auth/operator-only.js';
import {
  TenantExportController,
  TenantExportPolicy,
  TenantExports,
} from './tenant-export.controller.js';
import { TenantExport } from './tenant-export.js';
import { TransferFilesSweep } from './transfer-files.sweep.js';

/**
 * Exports and imports (README.md): the routes under /v1/data, the
 * `data-transfers` queue and its processor, saved column mappings and the
 * import limits. A record takes part by importing
 * `DataTransferModule.forRecord(DECLARATION)` in its feature module, which
 * brings this module along. Needs QueuesModule, StorageModule,
 * SharedOutboxModule, SharedLocksModule (the sweep of the files), JobsModule's
 * Redis and what AccessModule needs.
 */
@Module({
  imports: [
    ConfigModule.forFeature(dataTransferConfig),
    BullModule.registerQueue({
      name: DATA_TRANSFERS,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    SettingsModule.forFeature(DATA_TRANSFER_SETTINGS),
    AccessModule.forFeature(DATA_TRANSFER_PERMISSIONS),
    AuditModule,
    DiscoveryModule,
    JobsModule,
    RealtimeModule,
    RecordsModule,
  ],
  controllers: [
    DataTransferController,
    ImportMappingsController,
    TenantExportController,
  ],
  providers: [
    DataTransferService,
    DataTransferProcessor,
    ImportLimits,
    ImportMappingsService,
    ImportUpload,
    PrincipalNow,
    RecordTransfers,
    OperatorGuard,
    TenantExport,
    TenantExportPolicy,
    TenantExports,
    TransferFilesSweep,
  ],
  exports: [DataTransferService, PrincipalNow],
})
export class DataTransferModule {
  /** A record's exports and imports: one import in its feature module. */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: DataTransferRecordModule,
      imports: [DataTransferModule, RecordsModule],
      providers: [{ provide: RECORD, useValue: record }, TransferExtension],
    };
  }
}

/** The host of one forRecord(). */
@Module({})
class DataTransferRecordModule {}
