import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { aiConfig } from './ai.config.js';
import { AiRepository } from './ai.repository.js';

const JOB = 'ai-run-retention';

/** Rows deleted per statement: short transactions, short locks. */
const BATCH = 5_000;

/**
 * Deletes the ended runs (completed or failed) older than
 * AI_RUN_RETENTION_DAYS every night at 04:50 UTC, on one instance, across
 * tenants (`Tenancy.acrossTenants`). A queued or running one stays, however
 * old: its worker still writes to it.
 */
@Injectable()
export class AiRunRetentionJob {
  private readonly logger = new Logger('Ai');

  constructor(
    private readonly repository: AiRepository,
    private readonly tenancy: Tenancy,
    @Inject(aiConfig.KEY)
    private readonly config: ConfigType<typeof aiConfig>,
  ) {}

  /** Returns how many runs were deleted. */
  @Cron('50 4 * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'ai:run-retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const days = this.config.runRetentionDays;
    const before = new Date(now.getTime() - days * 86_400_000);
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const count = await this.repository.deleteEnded(before, BATCH);
        total += count;
        if (count < BATCH) return total;
      }
    });
    this.logger.log('Old AI runs deleted', { deleted, days });
    return deleted;
  }
}
