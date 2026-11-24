import { TransactionHost } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { deleteInBatches } from '../../core/database/batches.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { deliverabilityConfig } from './deliverability.config.js';
import { MAIL_EVENTS_RETENTION_JOB } from './deliverability.permissions.js';
import { DeliverabilityRepository } from './deliverability.repository.js';

/**
 * Deletes bounce, complaint and delivery events older than
 * MAIL_EVENTS_RETENTION_DAYS every night at 03:40 UTC, on one instance. The
 * suppression list itself is kept: an entry stays until an administrator
 * removes it.
 */
@Injectable()
export class MailEventsRetentionJob {
  private readonly logger = new Logger('MailEvents');

  constructor(
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @Inject(deliverabilityConfig.KEY)
    private readonly config: ConfigType<typeof deliverabilityConfig>,
    private readonly system: SystemContext,
    private readonly repository: DeliverabilityRepository,
  ) {}

  @Cron('40 3 * * *', { name: 'mail-events-retention', timeZone: 'UTC' })
  @OnOneInstance({ key: 'mail-events:retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      MAIL_EVENTS_RETENTION_JOB,
      async () => {
        const days = this.config.eventsRetentionDays;
        const before = new Date(now.getTime() - days * 86_400_000);
        // Each batch in its own transaction: short locks on a busy table.
        const total = await deleteInBatches((limit) =>
          this.txHost.withTransaction(() =>
            this.repository.deleteEventsBefore(before, limit),
          ),
        );
        this.logger.log('Old mail events deleted', { deleted: total, days });
        return total;
      },
      // A global table (every tenant's mail together): no tenant.
      { transaction: false, tenantId: null },
    );
  }
}
