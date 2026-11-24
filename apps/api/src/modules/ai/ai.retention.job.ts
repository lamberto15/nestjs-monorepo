import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, inArray, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { aiConfig } from './ai.config.js';
import { aiRuns } from './ai.tables.js';

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
    @InjectTransaction() private readonly db: Database,
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
    const old = and(
      inArray(aiRuns.status, ['completed', 'failed']),
      lt(aiRuns.createdAt, before),
    );
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const rows = await this.db
          .delete(aiRuns)
          .where(
            inArray(
              aiRuns.id,
              this.db
                .select({ id: aiRuns.id })
                .from(aiRuns)
                .where(old)
                .limit(BATCH),
            ),
          )
          .returning({ id: aiRuns.id });
        total += rows.length;
        if (rows.length < BATCH) return total;
      }
    });
    this.logger.log('Old AI runs deleted', { deleted, days });
    return deleted;
  }
}
