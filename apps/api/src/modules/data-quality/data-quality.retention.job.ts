import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { deleteInBatches } from '../../core/database/batches.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { dataQualityConfig } from './data-quality.config.js';
import { DataQualityRepository } from './data-quality.repository.js';

const JOB = 'data-quality-finding-retention';

/**
 * Deletes the findings no scan or recheck found again for
 * DATA_QUALITY_FINDING_RETENTION_DAYS (`checkedAt`) every night at 04:55
 * UTC, on one instance, across tenants (`Tenancy.acrossTenants`). One that
 * still holds is found again by the next scan.
 */
@Injectable()
export class DataQualityRetentionJob {
  private readonly logger = new Logger('DataQuality');

  constructor(
    private readonly repository: DataQualityRepository,
    private readonly tenancy: Tenancy,
    @Inject(dataQualityConfig.KEY)
    private readonly config: ConfigType<typeof dataQualityConfig>,
  ) {}

  /** Returns how many findings were deleted. */
  @Cron('55 4 * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'data-quality:finding-retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const days = this.config.findingRetentionDays;
    const before = new Date(now.getTime() - days * 86_400_000);
    const deleted = await this.tenancy.acrossTenants(JOB, () =>
      deleteInBatches((limit) =>
        this.repository.deleteFindingsBefore(before, limit),
      ),
    );
    this.logger.log('Old data-quality findings deleted', { deleted, days });
    return deleted;
  }
}
