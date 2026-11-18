import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { EncryptionAdminController } from './encryption-admin.controller.js';
import { ENCRYPTION_ADMIN_PERMISSIONS } from './encryption-admin.permissions.js';
import { EncryptionAdminPolicy } from './encryption-admin.policy.js';
import { EncryptionAdminProcessor } from './encryption-admin.processor.js';
import { EncryptionAdminScheduler } from './encryption-admin.scheduler.js';
import {
  EncryptionAdminService,
  REENCRYPTION_QUEUE,
} from './encryption-admin.service.js';

/**
 * Operating core/encryption's keys (README.md): the operators' status and
 * start routes, the `reencryption` queue and its hourly schedule. Needs
 * EncryptionModule, TenancyModule, QueuesModule, SharedLocksModule
 * (global), AuthModule and AccessModule.
 */
@Module({
  imports: [
    AccessModule.forFeature(ENCRYPTION_ADMIN_PERMISSIONS),
    AuditModule,
    BullModule.registerQueue({
      name: REENCRYPTION_QUEUE,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [EncryptionAdminController],
  providers: [
    EncryptionAdminService,
    EncryptionAdminPolicy,
    EncryptionAdminProcessor,
    EncryptionAdminScheduler,
  ],
  exports: [EncryptionAdminService],
})
export class EncryptionAdminModule {}
