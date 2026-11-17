import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, eq, lt, ne, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { messagingConfig } from './messaging.config.js';
import { MESSAGING_RETENTION_JOB } from './messaging.permissions.js';
import { previousMonthStart, utcDay } from './messaging.policy.js';
import { MessagingService } from './messaging.service.js';
import { messagingUsage } from './messaging.tables.js';

/**
 * Every night at 03:45 UTC, on one instance: removes the devices not seen
 * for MESSAGING_DEVICE_RETENTION_DAYS (a phone gone, an app uninstalled: its
 * provider never said so), the cap counters of days before yesterday (the
 * counters are per UTC day; yesterday's stay for the metrics) and the
 * monthly spend of months before the last.
 */
@Injectable()
export class MessagingRetentionJob {
  private readonly logger = new Logger('Messaging');

  constructor(
    @InjectTransaction() private readonly db: Database,
    @Inject(messagingConfig.KEY)
    private readonly config: ConfigType<typeof messagingConfig>,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
    private readonly messaging: MessagingService,
  ) {}

  @Cron('45 3 * * *', { name: 'messaging-retention', timeZone: 'UTC' })
  @OnOneInstance({ key: 'messaging:retention' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.system.run(
      MESSAGING_RETENTION_JOB,
      () =>
        this.tenancy.acrossTenants(MESSAGING_RETENTION_JOB.key, async () => {
          const days = this.config.deviceRetentionDays;
          const devices = await this.messaging.removeStaleDevices(
            new Date(now.getTime() - days * 86_400_000),
          );
          const removed = await this.db
            .delete(messagingUsage)
            .where(
              or(
                // The daily counters are of yesterday and before ...
                and(
                  ne(messagingUsage.counter, 'spend'),
                  lt(
                    messagingUsage.day,
                    utcDay(new Date(now.getTime() - 86_400_000)),
                  ),
                ),
                // ... the month's spend stays through the next month (for the alert's history).
                and(
                  eq(messagingUsage.counter, 'spend'),
                  lt(messagingUsage.day, previousMonthStart(now)),
                ),
              ),
            )
            .returning({ id: messagingUsage.id });
          this.logger.log('Messaging swept', {
            devices,
            counters: removed.length,
            days,
          });
          return { devices, counters: removed.length };
        }),
      { transaction: false, tenantId: null },
    );
  }
}
