import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { WebhookDeliveries } from '@nestjs/webhooks';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { queuesConfig, runsWorkers } from '../../core/queues/queues.config.js';

/**
 * `webhook_delivery_lag_seconds` (core/metrics): how long the most overdue
 * outgoing webhook delivery has waited (0 when none is). Shared state
 * (PostgreSQL): every worker reports the same value, aggregate with max().
 * Only worker processes report it.
 */
@Injectable()
export class WebhookMetrics implements OnModuleInit {
  constructor(
    private readonly deliveries: WebhookDeliveries,
    private readonly metrics: MetricsService,
    @Inject(queuesConfig.KEY)
    private readonly queues: ConfigType<typeof queuesConfig>,
  ) {}

  onModuleInit() {
    if (!runsWorkers(this.queues.role)) {
      return;
    }
    this.metrics.collect(
      'webhook_delivery_lag_seconds',
      'How long the most overdue webhook delivery has waited.',
      async () => [{ value: (await this.deliveries.stats()).lagMs / 1000 }],
      's',
    );
  }
}
