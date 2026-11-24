import {
  Inject,
  Injectable,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Queue } from 'bullmq';
import { MetricsService } from '../metrics/metrics.service.js';
import {
  queuesConfig,
  runsWorkers,
  type QueuesSettings,
} from './queues.config.js';

/**
 * `queue_oldest_waiting_seconds{queue}` (core/metrics): how long the oldest
 * waiting job of each registered queue has waited (0 when none waits), so a
 * backlog that stopped moving shows before its size alarms anyone. The queue
 * is shared state (Redis): every worker reports the same value, aggregate
 * with max(). Only worker processes report it.
 */
@Injectable()
export class QueueMetrics implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(queuesConfig.KEY) private readonly settings: QueuesSettings,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  onModuleInit() {
    if (!this.metrics || !runsWorkers(this.settings.role)) {
      return;
    }
    this.metrics.collect(
      'queue_oldest_waiting_seconds',
      'How long the oldest waiting job of each queue has waited (0: none waits).',
      async () => {
        const queues = new Map<string, Queue>();
        for (const wrapper of this.discovery.getProviders()) {
          const instance: unknown = wrapper.instance;
          if (instance instanceof Queue) queues.set(instance.name, instance);
        }
        const now = Date.now();
        return Promise.all(
          [...queues].map(async ([name, queue]) => {
            const [oldest] = await queue.getJobs(['waiting'], 0, 0, true);
            return {
              labels: { queue: name },
              value: oldest ? Math.max(0, now - oldest.timestamp) / 1000 : 0,
            };
          }),
        );
      },
      's',
    );
  }
}
