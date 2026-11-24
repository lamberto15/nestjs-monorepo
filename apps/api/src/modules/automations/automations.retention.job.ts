import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { deleteInBatches } from '../../core/database/batches.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { automationsConfig } from './automations.config.js';
import { AutomationsRepository } from './automations.repository.js';

const JOB = 'automation-run-retention';

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
    const deleted = await this.tenancy.acrossTenants(JOB, () =>
      deleteInBatches((limit) =>
        this.repository.deleteRunsBefore(before, limit),
      ),
    );
    this.logger.log('Old automation runs deleted', { deleted, days });
    return deleted;
  }
}
