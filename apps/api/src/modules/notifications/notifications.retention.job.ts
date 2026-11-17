import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, inArray, isNotNull, lt, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { DevicesService } from './notifications.devices.service.js';
import { notificationsConfig } from './notifications.config.js';
import { notifications } from './notifications.tables.js';

const JOB = 'notification-retention';

/** Rows deleted per statement: short transactions, short locks. */
const BATCH = 5_000;

const DAY = 86_400_000;

/**
 * Deletes read notifications older than NOTIFICATIONS_RETENTION_DAYS and any
 * older than NOTIFICATIONS_MAX_AGE_DAYS, and the push registrations of
 * browsers not seen for WEB_PUSH_DEVICE_RETENTION_DAYS, every night at 03:30
 * UTC, on one instance. A sweep of the whole table by age, the same rule for
 * every tenant, so across tenants (`Tenancy.acrossTenants`) rather than one
 * pass per tenant.
 */
@Injectable()
export class NotificationRetentionJob {
  private readonly logger = new Logger('Notifications');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
    private readonly devices: DevicesService,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @Cron('30 3 * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'notifications:retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const before = (days: number) => new Date(now.getTime() - days * DAY);
    const old = or(
      and(
        isNotNull(notifications.readAt),
        lt(notifications.readAt, before(this.config.retentionDays)),
      ),
      lt(notifications.createdAt, before(this.config.maxAgeDays)),
    );
    const deleted = await this.tenancy.acrossTenants(JOB, async () => {
      let total = 0;
      for (;;) {
        const rows = await this.db
          .delete(notifications)
          .where(
            inArray(
              notifications.id,
              this.db
                .select({ id: notifications.id })
                .from(notifications)
                .where(old)
                .limit(BATCH),
            ),
          )
          .returning({ id: notifications.id });
        total += rows.length;
        if (rows.length < BATCH) return total;
      }
    });
    const devices = await this.devices.sweep(
      before(this.config.deviceRetentionDays),
    );
    this.logger.log('Old notifications and devices deleted', {
      deleted,
      devices,
    });
    return { deleted, devices };
  }
}
