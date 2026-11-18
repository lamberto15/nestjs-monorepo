import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { inArray, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RECENTS_RETENTION_DAYS } from './recents.schemas.js';
import { recentRecords } from './recents.tables.js';

const JOB = 'recents-retention';

/** Rows deleted per statement: short transactions, short locks. */
const BATCH = 5_000;

/**
 * Deletes recent records older than RECENTS_RETENTION_DAYS every night at
 * 03:40 UTC, on one instance: a sweep of the whole table by age, the same
 * rule for every tenant (`Tenancy.acrossTenants`).
 */
@Injectable()
export class RecentsRetentionJob {
  private readonly logger = new Logger('Recents');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
  ) {}

  @Cron('40 3 * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'recents:retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const before = new Date(
      now.getTime() - RECENTS_RETENTION_DAYS * 86_400_000,
    );
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const rows = await this.db
          .delete(recentRecords)
          .where(
            inArray(
              recentRecords.id,
              this.db
                .select({ id: recentRecords.id })
                .from(recentRecords)
                .where(lt(recentRecords.viewedAt, before))
                .limit(BATCH),
            ),
          )
          .returning({ id: recentRecords.id });
        total += rows.length;
        if (rows.length < BATCH) return total;
      }
    });
    this.logger.log('Old recent records deleted', { deleted });
    return deleted;
  }
}
