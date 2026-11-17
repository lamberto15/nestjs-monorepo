import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, isNotNull, lt } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { systemPrincipal } from '../../iam/auth/principal.js';
import { notHeld } from '../../iam/holds/holds.tables.js';
import { recordsConfig } from './records.config.js';
import { Records } from './records.service.js';

/** The job's principal: `system:recycle-bin-purge` in the log. */
export const RECYCLE_BIN_PURGE = systemPrincipal({
  key: 'recycle-bin-purge',
  label: 'Recycle bin purge',
});

/** Records purged per transaction. */
const BATCH = 500;

/**
 * Empties the recycle bins: every night at 03:45 UTC, on one instance,
 * deletes for good the records of each registered record with `softDelete`
 * that were deleted longer ago than its `recycleBinDays` (default
 * SOFT_DELETE_RETENTION_DAYS), never one under a legal hold (`notHeld`).
 * Per tenant (deactivated ones too), in batches, each one transaction of
 * RecordStore.purge(): the references emptied, the add-ons' `purged`
 * hooks, the audit entry `records.purged`.
 */
@Injectable()
export class RecycleBinPurgeJob {
  private readonly logger = new Logger(RecycleBinPurgeJob.name);

  constructor(
    @Inject(recordsConfig.KEY)
    private readonly config: ConfigType<typeof recordsConfig>,
    private readonly records: Records,
    private readonly tenancy: Tenancy,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  @Cron('45 3 * * *', { name: 'recycle-bin-purge', timeZone: 'UTC' })
  @OnOneInstance({ key: 'records:recycle-bin-purge' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const counts = await this.tenancy.forEachTenant(
      RECYCLE_BIN_PURGE.id,
      () => this.purge(now),
      { includeInactive: true },
    );
    let total = 0;
    for (const count of counts.values()) total += count;
    this.logger.log(`Recycle bins emptied: ${total} records`);
    return total;
  }

  /** The current tenant's recycle bins. */
  private async purge(now: Date) {
    let total = 0;
    for (const record of this.records.all()) {
      const { declaration, feature, store } = record;
      if (!declaration.softDelete) continue;
      const days = declaration.recycleBinDays ?? this.config.recycleBinDays;
      const before = new Date(now.getTime() - days * 86_400_000);
      const t = feature.table;
      for (;;) {
        const rows = await this.txHost.tx
          .select({ id: t.id })
          .from(t as unknown as PgTable)
          .where(
            and(
              isNotNull(t.deletedAt!),
              lt(t.deletedAt!, before),
              notHeld(declaration.subject, t.id),
            ),
          )
          .limit(BATCH);
        const ids = rows.map((row) => row.id as string);
        await store.purge(RECYCLE_BIN_PURGE, ids);
        total += ids.length;
        if (ids.length < BATCH) break;
      }
    }
    return total;
  }
}
