import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, eq, exists, gt, inArray, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { revisionsConfig } from './revisions.config.js';
import { revisions } from './revisions.tables.js';

const JOB = 'revisions-retention';
const BATCH = 5000;
const newer = alias(revisions, 'newer');

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
  private readonly logger = new Logger('Revisions');

  constructor(
    @InjectTransaction() private readonly db: Database,
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
    const old = and(
      lt(revisions.changedAt, new Date(now.getTime() - days * 86_400_000)),
      // Not a record's latest: a newer revision of the same record exists.
      exists(
        this.db
          .select({ one: newer.id })
          .from(newer)
          .where(
            and(
              eq(newer.tenantId, revisions.tenantId),
              eq(newer.subject, revisions.subject),
              eq(newer.recordId, revisions.recordId),
              gt(newer.number, revisions.number),
            ),
          ),
      ),
    );
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const rows = await this.db
          .delete(revisions)
          .where(
            inArray(
              revisions.id,
              this.db
                .select({ id: revisions.id })
                .from(revisions)
                .where(old)
                .limit(BATCH),
            ),
          )
          .returning({ id: revisions.id });
        total += rows.length;
        if (rows.length < BATCH) return total;
      }
    });
    this.logger.log('Old revisions deleted', { deleted, days });
    return deleted;
  }
}
