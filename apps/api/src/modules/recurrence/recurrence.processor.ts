import { Processor } from '@nestjs/bullmq';
import { SystemContext } from '../../iam/access/system-context.js';
import { TenantWorkerHost } from '../../core/tenancy/tenant-job.js';
import { RECORD_SCHEDULE_JOB } from './recurrence.permissions.js';
import {
  RECORD_SCHEDULE_QUEUE,
  RecurrenceService,
} from './recurrence.service.js';

/**
 * Creates the due records of one tenant (the job's), as
 * `system:record-schedules` for the audit, each record as its schedule's
 * owner. One at a time per worker; every occurrence commits on its own.
 */
@Processor(RECORD_SCHEDULE_QUEUE, { concurrency: 1 })
export class RecurrenceProcessor extends TenantWorkerHost<object, number> {
  constructor(
    private readonly recurrence: RecurrenceService,
    private readonly system: SystemContext,
  ) {
    super();
  }

  handle() {
    return this.system.run(
      RECORD_SCHEDULE_JOB,
      (system) => this.recurrence.runTenant(system),
      { transaction: false },
    );
  }
}
