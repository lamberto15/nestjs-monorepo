import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { CalendarsModule } from '../calendars/calendars.module.js';
import { RecurrenceController } from './recurrence.controller.js';
import { RECURRENCE_PERMISSIONS } from './recurrence.permissions.js';
import { RecurrenceProcessor } from './recurrence.processor.js';
import { RecurrenceScheduler } from './recurrence.scheduler.js';
import {
  RECORD_SCHEDULE_QUEUE,
  RecurrenceService,
} from './recurrence.service.js';
import {
  ScheduleTargetRegistration,
  type ScheduleTarget,
  ScheduleTargets,
} from './recurrence.targets.js';

/**
 * Recurring record schedules (README.md): the routes under
 * /record-schedules, the `record-schedules` queue and its processor, the
 * scheduler. A module whose records can be scheduled declares them in its
 * own imports, `RecurrenceModule.forFeature({ … })`. Needs QueuesModule,
 * SharedLocksModule, AuthModule (global) and the tenancy and database
 * modules.
 */
@Module({
  imports: [
    AccessModule.forFeature(RECURRENCE_PERMISSIONS),
    AuditModule,
    CalendarsModule,
    DiscoveryModule,
    BullModule.registerQueue({
      name: RECORD_SCHEDULE_QUEUE,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [RecurrenceController],
  providers: [
    ScheduleTargets,
    RecurrenceService,
    RecurrenceProcessor,
    RecurrenceScheduler,
  ],
})
export class RecurrenceModule {
  /**
   * A kind of record a schedule may create (ScheduleTarget). Import it in the
   * module that owns the records; ScheduleTargets finds every declaration at
   * startup.
   */
  static forFeature(target: ScheduleTarget): DynamicModule {
    return {
      module: RecurrenceFeatureModule,
      providers: [
        {
          provide: ScheduleTargetRegistration,
          useValue: new ScheduleTargetRegistration(target),
        },
      ],
    };
  }
}

/** The host of one `RecurrenceModule.forFeature()` declaration. */
@Module({})
class RecurrenceFeatureModule {}
