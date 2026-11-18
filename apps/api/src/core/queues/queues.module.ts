import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import type { ConnectionOptions } from 'bullmq';
import { redisConfig } from '../redis/redis.config.js';
import { producerRedisOptions } from '../redis/redis.js';
import { RedisModule } from '../redis/redis.module.js';
import { QueueMetrics } from './queue.metrics.js';
import { QueueWorkers } from './queue-workers.js';
import { DEFAULT_JOB_OPTIONS, QueueWorker } from './queues.js';
import { queuesConfig } from './queues.config.js';

BullModule.workerClass = QueueWorker;

/**
 * BullMQ on Redis (@nestjs/bullmq): the root connection and the job
 * defaults. A module that needs a queue registers it in its own folder:
 * BullModule.registerQueue({ name: 'mail' }) in its imports, then
 * @InjectQueue('mail') to add jobs and a @Processor('mail') class to consume
 * them. Producers work in every process; consumers only where APP_ROLE is
 * worker or all (QueueWorkers).
 */
@Module({
  imports: [
    ConfigModule.forFeature(queuesConfig),
    RedisModule,
    DiscoveryModule,
    BullModule.forRootAsync({
      imports: [ConfigModule.forFeature(redisConfig)],
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) => ({
        // The queues (producers) fail fast; BullMQ makes the connections of
        // the workers it creates from these options block and wait for Redis.
        connection: producerRedisOptions(config) as ConnectionOptions,
        prefix: `${config.prefix}:bull`,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
      extraOptions: { manualRegistration: true },
    }),
  ],
  providers: [QueueWorkers, QueueMetrics],
})
export class QueuesModule {}
