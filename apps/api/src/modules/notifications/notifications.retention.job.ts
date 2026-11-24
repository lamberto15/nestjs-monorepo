import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { deleteInBatches } from '../../core/database/batches.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { DevicesService } from './notifications.devices.service.js';
import { notificationsConfig } from './notifications.config.js';
import { NotificationsRepository } from './notifications.repository.js';

const JOB = 'notification-retention';

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
    private readonly repository: NotificationsRepository,
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
    const deleted = await this.tenancy.acrossTenants(JOB, () =>
      deleteInBatches((limit) =>
        this.repository.deleteOld(
          before(this.config.retentionDays),
          before(this.config.maxAgeDays),
          limit,
        ),
      ),
    );
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
