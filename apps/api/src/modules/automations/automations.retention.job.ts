import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { automationsConfig } from './automations.config.js';
import { AutomationsRepository } from './automations.repository.js';

const JOB = 'automation-run-retention';

/** Rows deleted per statement: short transactions, short locks. */
const BATCH = 5_000;

/**
 * Deletes the run log's runs older than AUTOMATIONS_RUN_RETENTION_DAYS
 * every night at 04:40 UTC, on one instance: a sweep of the whole table by
 * age, the same rule for every tenant (`Tenancy.acrossTenants`).
 */
@Injectable()
export class AutomationRunRetentionJob {
  private readonly logger = new Logger('Automations');

  constructor(
    private readonly repository: AutomationsRepository,
    private readonly tenancy: Tenancy,
    @Inject(automationsConfig.KEY)
    private readonly config: ConfigType<typeof automationsConfig>,
  ) {}

  /** Returns how many runs were deleted. */
  @Cron('40 4 * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'automations:run-retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const days = this.config.runRetentionDays;
    const before = new Date(now.getTime() - days * 86_400_000);
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const count = await this.repository.deleteRunsBefore(before, BATCH);
        total += count;
        if (count < BATCH) return total;
      }
    });
    this.logger.log('Old automation runs deleted', { deleted, days });
    return deleted;
  }
}
