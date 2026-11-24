import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { revisionsConfig } from './revisions.config.js';
import { RevisionsRepository } from './revisions.repository.js';

const JOB = 'revisions-retention';
const BATCH = 5000;

/**
 * Deletes revisions older than REVISIONS_RETENTION_DAYS, every night at
 * 03:25 UTC, on one instance; the latest revision of each record always
 * stays (it is the record's current state, and the next change is diffed
 * against it). A sweep of the whole table by age, the same rule in every
 * tenant: across tenants (`Tenancy.acrossTenants`), "newer" compared within
 * a tenant.
 */
@Injectable()
export class RevisionRetentionJob {
  private readonly logger = new Logger(RevisionRetentionJob.name);

  constructor(
    private readonly repository: RevisionsRepository,
    private readonly tenancy: Tenancy,
    @Inject(revisionsConfig.KEY)
    private readonly config: ConfigType<typeof revisionsConfig>,
  ) {}

  /** Returns how many revisions were deleted. */
  @Cron('25 3 * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'revisions:retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const days = this.config.retentionDays;
    const before = new Date(now.getTime() - days * 86_400_000);
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const gone = await this.repository.deleteOlderThan(before, BATCH);
        total += gone;
        if (gone < BATCH) return total;
      }
    });
    this.logger.log('Old revisions deleted', { deleted, days });
    return deleted;
  }
}
