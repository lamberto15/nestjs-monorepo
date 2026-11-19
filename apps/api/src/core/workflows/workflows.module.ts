import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { getDrizzleToken } from '@nestjs/drizzle';
import { WorkflowsModule, WorkflowStorage } from '@nestjs/workflows';
import { fromDrizzle, PostgresWorkflowStore } from '@nestjs/workflows/postgres';
import type { Database } from '../database/database.js';
import { encryptionConfig } from '../encryption/encryption.config.js';
import { queuesConfig, runsWorkers } from '../queues/queues.config.js';
import { workflowPayloadCodec } from './workflow-payload.codec.js';
import { workflowsConfig } from './workflows.config.js';
import { WorkflowsRetentionJob } from './workflows-retention.job.js';

/**
 * Durable workflows (@nestjs/workflows on PostgreSQL): a module registers
 * its `@Workflow()` class as a provider and injects `WorkflowClient` to
 * start it (README.md). Steps run where the process runs workers (APP_ROLE
 * worker or all). The module is global.
 *
 * The store only checks its schema (nest_workflows) at start: the app's role
 * may not create tables, so the schema comes with the migrations, run as the owner.
 */
@Module({
  imports: [
    ConfigModule.forFeature(workflowsConfig),
    WorkflowsModule.forRootAsync({
      imports: [
        ConfigModule.forFeature(workflowsConfig),
        ConfigModule.forFeature(queuesConfig),
        ConfigModule.forFeature(encryptionConfig),
      ],
      inject: [workflowsConfig.KEY, queuesConfig.KEY, encryptionConfig.KEY],
      useFactory: (
        workflows: ConfigType<typeof workflowsConfig>,
        queues: ConfigType<typeof queuesConfig>,
        encryption: ConfigType<typeof encryptionConfig>,
      ) => ({
        // What workflows store is encrypted when DATA_ENCRYPTION_KEYS is set.
        codec: workflowPayloadCodec(encryption.dataKeys),
        worker: {
          enabled: workflows.worker && runsWorkers(queues.role),
          concurrency: workflows.concurrency,
          leaseDuration: '30s', // how long a crashed process keeps its instances
          shutdownTimeout: '10s', // how long a deploy waits for running steps
        },
      }),
    }),
  ],
  providers: [
    {
      provide: PostgresWorkflowStore,
      inject: [getDrizzleToken(), WorkflowStorage],
      useFactory: (db: Database, storage: WorkflowStorage) =>
        new PostgresWorkflowStore(
          { executor: fromDrizzle(db), migrate: false },
          storage,
        ),
    },
    WorkflowsRetentionJob,
  ],
})
export class SharedWorkflowsModule {}
