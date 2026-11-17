import { setTimeout } from 'node:timers/promises';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { BullRegistrar, QueueEventsHost, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { QueueBase, type Worker } from 'bullmq';
import { RedisService } from '../redis/redis.service.js';
import { applyQueueConcurrency, closeWhenRedisIsDown } from './queues.js';
import {
  consumesQueue,
  queuesConfig,
  runsWorkers,
  type QueuesSettings,
} from './queues.config.js';

/**
 * Starts the consumers (@Processor, @QueueEventsListener) only where the
 * process runs workers, and stops them on shutdown even when Redis is gone.
 * @nestjs/bullmq registers them in onModuleInit unless told not to
 * (manualRegistration, QueuesModule), so an api process creates none.
 */
@Injectable()
export class QueueWorkers implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger('Queues');

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @Inject(queuesConfig.KEY) private readonly settings: QueuesSettings,
    // Provided once some module registers a queue: without one there is nothing to start.
    @Optional() private readonly registrar?: BullRegistrar,
  ) {}

  onModuleInit() {
    for (const queue of this.clients().others) {
      closeWhenRedisIsDown(queue);
    }
    if (!runsWorkers(this.settings.role) || !this.registrar) {
      return;
    }
    this.registrar.register();
    const { workers } = this.clients();
    applyQueueConcurrency(workers, (key) => this.config.get<string>(key));
    // Never started (QueueWorker), and closed, so its connections don't
    // count as a worker for the queue.
    const skipped = workers.filter(
      (worker) => !consumesQueue(worker.name, this.settings),
    );
    if (skipped.length > 0) {
      this.logger.log(
        `Left to another worker: ${skipped.map((worker) => worker.name).join(', ')}.`,
      );
      for (const worker of skipped) {
        worker.close().catch((error: unknown) => {
          this.logger.warn(`Closing ${worker.name}'s worker: ${String(error)}`);
        });
      }
    }
  }

  /**
   * @nestjs/bullmq closes its workers in onApplicationShutdown, the phase in
   * which the database pool and the Redis client close too: a job still
   * running would finish into closed clients. So the workers are closed here,
   * before: close() waits for their running jobs while everything they use is
   * open (BullModule's own close afterwards returns the same promise).
   *
   * With Redis gone (or no longer answering) none of that settles (the QUIT
   * waits for a reconnect, or for a reply) and the process never exits. So
   * when Redis doesn't answer a PING within 2 s, the workers are closed with
   * close(true) (BullMQ's force: no waiting for jobs, connections dropped)
   * and the other clients are disconnect()ed. Running jobs can't be handed
   * back without Redis: they turn stalled and run again on another worker.
   */
  async beforeApplicationShutdown() {
    const { workers, others } = this.clients();
    if (workers.length + others.length === 0) {
      return;
    }
    if (await this.redis.ping()) {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      return;
    }
    this.logger.warn(
      `Redis doesn't answer: closing ${workers.length} queue workers without waiting for their jobs.`,
    );
    // The producers are also closed by BullModule's own shutdown, which only
    // survives a lost connection because of closeWhenRedisIsDown()
    // (onModuleInit): do not remove that wrapper.
    await Promise.race([
      Promise.allSettled([
        ...workers.map((worker) => worker.close(true)),
        ...others.map((client) => client.disconnect()),
      ]),
      setTimeout(2000, undefined, { ref: false }),
    ]);
  }

  /** The running workers, and the queues and queue-event listeners. */
  private clients() {
    const workers: Worker[] = [];
    const others: QueueBase[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof WorkerHost && instance['_worker']) {
        workers.push(instance.worker);
      } else if (
        instance instanceof QueueEventsHost &&
        instance['_queueEvents']
      ) {
        others.push(instance.queueEvents);
      } else if (instance instanceof QueueBase) {
        others.push(instance);
      }
    }
    return { workers, others };
  }
}
