import { TransactionHost } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { systemPrincipal } from '../auth/principal.js';
import { auditConfig } from './audit.config.js';
import { AuditService } from './audit.service.js';
import { AuditRepository } from './audit.repository.js';

/** The job's principal: `system:audit-retention` in the log. */
export const AUDIT_RETENTION = systemPrincipal({
  key: 'audit-retention',
  label: 'Audit retention',
});

/** Entries deleted per transaction. */
const BATCH = 5000;

/**
 * Deletes audit entries older than AUDIT_RETENTION_DAYS, every night at
 * 03:15 UTC, on one instance (@nestjs/locks), as the system principal. Per
 * tenant: each tenant's log is pruned in that tenant's scope (deactivated
 * tenants too), and its own `audit.pruned` entry (what was deleted) lands
 * in that tenant's log, in the transaction of each batch; then once
 * outside every tenant for the account-level entries, whose `audit.pruned`
 * has none either. Not the maintenance role's bypass: a whole-table
 * delete would leave the record of it in no tenant's log. A tenant's
 * failure stops neither the others nor the last pass, and is reported
 * after it.
 */
@Injectable()
export class AuditRetentionJob {
  private readonly logger = new Logger(AuditRetentionJob.name);

  constructor(
    @Inject(auditConfig.KEY)
    private readonly config: ConfigType<typeof auditConfig>,
    private readonly audit: AuditService,
    private readonly repository: AuditRepository,
    private readonly tenancy: Tenancy,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  @Cron('15 3 * * *', { name: 'audit-retention', timeZone: 'UTC' })
  @OnOneInstance({ key: 'iam:audit-retention' })
  @WithoutOverlapping()
  async run() {
    const days = this.config.retentionDays;
    const before = new Date(Date.now() - days * 86_400_000);
    let total = 0;
    let failed: unknown;
    try {
      const counts = await this.tenancy.forEachTenant(
        AUDIT_RETENTION.id,
        () => this.prune(before, days),
        { includeInactive: true },
      );
      for (const count of counts.values()) total += count;
    } catch (error) {
      failed = error; // each failure logged by forEachTenant
    }
    total += await this.tenancy.run(null, () => this.prune(before, days));
    this.logger.log(
      `Old audit entries deleted: ${total} (older than ${days} days)`,
    );
    if (failed) {
      throw failed;
    }
    return total;
  }

  /** Batches in the current scope, each with the record of its deletion in its transaction. */
  private async prune(before: Date, days: number) {
    let total = 0;
    for (;;) {
      const deleted = await this.txHost.withTransaction(async () => {
        const rows = await this.repository.deleteOlderThan(before, BATCH);
        if (rows.length > 0) {
          // Who removed history, and how much: never itself pruned this run.
          await this.audit.record(AUDIT_RETENTION, {
            action: 'audit.pruned',
            details: {
              deleted: rows.length,
              days,
              before: before.toISOString(),
            },
          });
        }
        return rows.length;
      });
      total += deleted;
      if (deleted < BATCH) {
        return total;
      }
    }
  }
}
