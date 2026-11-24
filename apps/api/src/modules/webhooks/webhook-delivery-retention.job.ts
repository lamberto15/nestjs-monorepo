import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { WebhookDeliveries } from '@nestjs/webhooks';
import { webhooksConfig } from './webhooks.config.js';
import { WebhooksRepository } from './webhooks.repository.js';

/**
 * Deletes outgoing deliveries that succeeded or failed for good more than
 * WEBHOOKS_DELIVERY_RETENTION_DAYS ago, every night at 03:35 UTC, on one
 * instance; a delivery still pending (waiting for a retry) is never
 * touched. The package prunes (`WebhookDeliveries.prune()`: the deliveries,
 * their attempt logs, the messages left without one) but never on its own;
 * this job then deletes the recorded requests (webhook.transport.ts) whose
 * delivery is gone. Both tables are global: one rule for every tenant.
 */
@Injectable()
export class WebhookDeliveryRetentionJob {
  private readonly logger = new Logger('Webhooks');

  constructor(
    @Inject(webhooksConfig.KEY)
    private readonly config: ConfigType<typeof webhooksConfig>,
    private readonly deliveries: WebhookDeliveries,
    private readonly repository: WebhooksRepository,
  ) {}

  /** Returns how many deliveries and recorded requests were deleted. */
  @Cron('35 3 * * *', { name: 'webhook-delivery-retention', timeZone: 'UTC' })
  @OnOneInstance({ key: 'webhooks:delivery-retention' })
  @WithoutOverlapping()
  async run() {
    const days = this.config.retentionDays;
    const deliveries = await this.deliveries.prune(`${days}d`);
    // After the package: a request row outlives its delivery by a night at most.
    // A nightly job has no ambient transaction: the delete commits on its own.
    const requests = await this.repository.deleteOrphanRequests();
    this.logger.log(
      `Old webhook deliveries deleted: ${deliveries} deliveries, ${requests} recorded requests (${days} days).`,
    );
    return { deliveries, requests };
  }
}
