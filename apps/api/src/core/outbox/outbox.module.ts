import { Global, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromDrizzle, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import type { Database } from '../database/database.js';
import { queuesConfig, runsWorkers } from '../queues/queues.config.js';
import { Events } from './events.js';
import { outboxConfig } from './outbox.config.js';
import { OutboxMetrics } from './outbox.metrics.js';
import { OutboxRetentionJob } from './outbox-retention.job.js';

/**
 * The transactional outbox (@nestjs/outbox on PostgreSQL), and the domain
 * events built on it (events.ts). A module writes its event in the
 * transaction of its change; the relay delivers it after the commit, in the
 * worker process (APP_ROLE worker or all), to the `@OnDomainEvent()`
 * subscribers, in the tenant the event was published in.
 *
 * The store only checks its schema (nest_outbox) at start: the app's role
 * may not create tables, so the schema comes with the migrations, run as the
 * owner (README.md). The module is global: Events, Outbox, OutboxDeadLetters.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forFeature(outboxConfig),
    ConfigModule.forFeature(queuesConfig),
    OutboxModule.forRootAsync({
      imports: [
        ConfigModule.forFeature(outboxConfig),
        ConfigModule.forFeature(queuesConfig),
      ],
      inject: [outboxConfig.KEY, queuesConfig.KEY],
      useFactory: (
        outbox: ConfigType<typeof outboxConfig>,
        queues: ConfigType<typeof queuesConfig>,
      ) => ({
        relay: {
          enabled: outbox.relay && runsWorkers(queues.role),
          pollInterval: '1s',
          batchSize: outbox.batchSize,
          concurrency: outbox.concurrency,
        },
      }),
    }),
  ],
  providers: [
    {
      provide: PostgresOutboxStore,
      inject: [getDrizzleToken(), OutboxStorage],
      useFactory: (db: Database, storage: OutboxStorage) =>
        new PostgresOutboxStore(
          { executor: fromDrizzle(db), migrate: false },
          storage,
        ),
    },
    Events,
    OutboxMetrics,
    OutboxRetentionJob,
  ],
  exports: [Events],
})
export class SharedOutboxModule {}
