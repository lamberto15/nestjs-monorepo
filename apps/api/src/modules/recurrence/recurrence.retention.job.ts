import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { deleteInBatches } from '../../core/database/batches.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { recurrenceConfig } from './recurrence.config.js';
import { RecurrenceRepository } from './recurrence.repository.js';

const JOB = 'record-schedule-run-retention';

/**
 * Forgets the occurrences handled more than RECURRENCE_RUN_RETENTION_DAYS
 * ago every night at 04:45 UTC, on one instance, across tenants
 * (`Tenancy.acrossTenants`). Dated by the occurrence, not by when it was
 * handled: a schedule never goes back to an occurrence before now, so an
 * old one's guard against a second record is no longer needed.
 */
@Injectable()
export class RecurrenceRetentionJob {
  private readonly logger = new Logger(RecurrenceRetentionJob.name);

  constructor(
    private readonly repository: RecurrenceRepository,
    private readonly tenancy: Tenancy,
    @Inject(recurrenceConfig.KEY)
    private readonly config: ConfigType<typeof recurrenceConfig>,
  ) {}

  /** Returns how many runs were deleted. */
  @Cron('45 4 * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'record-schedules:run-retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const days = this.config.runRetentionDays;
    const before = new Date(now.getTime() - days * 86_400_000);
    const deleted = await this.tenancy.acrossTenants(JOB, () =>
      deleteInBatches((limit) =>
        this.repository.deleteRunsBefore(before, limit),
      ),
    );
    this.logger.log('Old schedule runs deleted', { deleted, days });
    return deleted;
  }
}
