import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { RecordPurges } from './record-purge.js';
import { RetentionController } from './retention.controller.js';
import { RETENTION_PERMISSIONS } from './retention.permissions.js';
import { RetentionPolicy } from './retention.policy.js';
import { RetentionProcessor } from './retention.processor.js';
import {
  RetentionRegistration,
  type RetentionRule,
  RetentionRules,
} from './retention.rules.js';
import { RetentionScheduler } from './retention.scheduler.js';
import { RETENTION_QUEUE, RetentionService } from './retention.service.js';

/**
 * Retention rules and the nightly purge (README.md): the routes under
 * /retention/rules, the `retention` queue and its processor, the scheduler.
 * A module that owns personal data declares how its records age in its own
 * imports, `RetentionModule.forFeature({ … })`. Needs QueuesModule,
 * SharedLocksModule, AuthModule (global) and the tenancy and database modules.
 */
@Module({
  imports: [
    AccessModule.forFeature(RETENTION_PERMISSIONS),
    AuditModule,
    DiscoveryModule,
    BullModule.registerQueue({
      name: RETENTION_QUEUE,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [RetentionController],
  providers: [
    RetentionRules,
    RecordPurges,
    RetentionService,
    RetentionPolicy,
    RetentionProcessor,
    RetentionScheduler,
  ],
  exports: [RecordPurges],
})
export class RetentionModule {
  /**
   * How long a kind of record is kept (RetentionRule). Import it in the
   * module that owns the table; RetentionRules finds every declaration at
   * startup and refuses an inconsistent one. Does nothing until a tenant
   * turns the rule on.
   */
  static forFeature(rule: RetentionRule): DynamicModule {
    return {
      module: RetentionFeatureModule,
      providers: [
        {
          provide: RetentionRegistration,
          useValue: new RetentionRegistration(rule),
        },
      ],
    };
  }
}

/** The host of one `RetentionModule.forFeature()` declaration. */
@Module({})
class RetentionFeatureModule {}
