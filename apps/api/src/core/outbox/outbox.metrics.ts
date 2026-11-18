import {
  Inject,
  Injectable,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OutboxRelay } from '@nestjs/outbox';
import { MetricsService } from '../metrics/metrics.service.js';
import { queuesConfig, runsWorkers } from '../queues/queues.config.js';

/**
 * `outbox_lag_seconds` on `/metrics`: how long the longest-waiting due
 * outbox message has waited (0 when none does), the relay's own `lagMs`.
 * Shared state (PostgreSQL): every worker reports the same value, aggregate
 * with max(). Only worker processes report it.
 */
@Injectable()
export class OutboxMetrics implements OnModuleInit {
  constructor(
    private readonly relay: OutboxRelay,
    @Inject(queuesConfig.KEY)
    private readonly queues: ConfigType<typeof queuesConfig>,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit() {
    if (!this.metrics || !runsWorkers(this.queues.role)) {
      return;
    }
    this.metrics.collect(
      'outbox_lag_seconds',
      'How long the longest-waiting due outbox message has waited.',
      async () => [{ value: (await this.relay.stats()).lagMs / 1000 }],
    );
  }
}
