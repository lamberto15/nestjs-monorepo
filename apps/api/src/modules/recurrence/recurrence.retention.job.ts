import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { inArray, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { recurrenceConfig } from './recurrence.config.js';
import { recordScheduleRuns } from './recurrence.tables.js';

const JOB = 'record-schedule-run-retention';

/** Rows deleted per statement: short transactions, short locks. */
const BATCH = 5_000;

/**
 * Forgets the occurrences handled more than RECURRENCE_RUN_RETENTION_DAYS
 * ago every night at 04:45 UTC, on one instance, across tenants
 * (`Tenancy.acrossTenants`). Dated by the occurrence, not by when it was
 * handled: a schedule never goes back to an occurrence before now, so an
 * old one's guard against a second record is no longer needed.
 */
@Injectable()
export class RecurrenceRetentionJob {
  private readonly logger = new Logger('Recurrence');

  constructor(
    @InjectTransaction() private readonly db: Database,
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
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const rows = await this.db
          .delete(recordScheduleRuns)
          .where(
            inArray(
              recordScheduleRuns.id,
              this.db
                .select({ id: recordScheduleRuns.id })
                .from(recordScheduleRuns)
                .where(lt(recordScheduleRuns.occurrenceAt, before))
                .limit(BATCH),
            ),
          )
          .returning({ id: recordScheduleRuns.id });
        total += rows.length;
        if (rows.length < BATCH) return total;
      }
    });
    this.logger.log('Old schedule runs deleted', { deleted, days });
    return deleted;
  }
}
