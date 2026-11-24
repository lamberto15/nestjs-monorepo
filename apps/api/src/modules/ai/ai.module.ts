import { AiModule as NestAiModule } from '@nestjs/ai';
import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { ApiClientsModule } from '../../iam/api-clients/api-clients.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { QuotasModule } from '../quotas/quotas.module.js';
import type { RecordDeclaration } from '../records/record.js';
import { RecordsModule } from '../records/records.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { aiConfig } from './ai.config.js';
import { AiController } from './ai.controller.js';
import { aiModuleOptions } from './ai.models.js';
import { AiProcessor } from './ai.processor.js';
import { AiRunRetentionJob } from './ai.retention.job.js';
import { AI_TOKENS } from './ai.quota.js';
import { AiRepository } from './ai.repository.js';
import { AI, AiService } from './ai.service.js';
import { AI_SETTINGS } from './ai.settings.js';
import { AiSourceRegistration, AiSources } from './ai.source.js';
import { AiPersonalData } from './ai.personal-data.js';
import { AiFeature } from './ai.feature.js';

/**
 * The AI helper (README.md): runs of a model over a record, their routes,
 * the queue, the tenant's opt-in and daily token quota. A record takes it
 * with `AiModule.forRecord(RECORD)`. Named apart from @nestjs/ai's module,
 * which it imports. Needs the core (database, tenancy, queues, redis),
 * AuthModule, AccessModule and what settings and quotas need.
 */
@Module({
  imports: [
    ConfigModule.forFeature(aiConfig),
    // The models of the helper: Anthropic, through @nestjs/ai.
    NestAiModule.forRootAsync({
      imports: [ConfigModule.forFeature(aiConfig)],
      inject: [aiConfig.KEY],
      useFactory: aiModuleOptions,
    }),
    BullModule.registerQueue({
      name: AI,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    SettingsModule.forFeature(AI_SETTINGS),
    QuotasModule.forFeature(AI_TOKENS),
    RecordsModule,
    AuditModule,
    RealtimeModule,
    ApiClientsModule,
    DiscoveryModule,
  ],
  controllers: [AiController],
  providers: [
    AiSources,
    AiService,
    AiRepository,
    AiProcessor,
    AiPersonalData,
    AiFeature,
    AiRunRetentionJob,
  ],
})
export class AiModule {
  /**
   * Lets people ask the helper about this record: the feature's own import.
   * The request names the record by its collection path (`source`).
   *
   * ```ts
   * imports: [AiModule.forRecord(NOTE)]
   * ```
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: AiRecordModule,
      imports: [AiModule],
      providers: [
        {
          provide: AiSourceRegistration,
          useValue: new AiSourceRegistration(record),
        },
      ],
    };
  }
}

/** The host of one `AiModule.forRecord()` registration. */
@Module({})
class AiRecordModule {}
