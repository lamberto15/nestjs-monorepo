import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { httpConfig } from '../../core/http/http.config.js';
import { SharedHttpClientModule } from '../../core/http-client/http-client.module.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { MessagingLimits } from './messaging-limits.service.js';
import { messagingConfig } from './messaging.config.js';
import { MessagingController } from './messaging.controller.js';
import { MESSAGING_PERMISSIONS } from './messaging.permissions.js';
import {
  messagingClients,
  pushProvider,
  smsProvider,
} from './messaging.providers.js';
import { MessagingProcessor } from './messaging.processor.js';
import { MESSAGING } from './messaging.queue.js';
import { MessagingRetentionJob } from './messaging.retention.job.js';
import { MessagingSender } from './messaging.sender.js';
import { MessagingRepository } from './messaging.repository.js';
import { MessagingService } from './messaging.service.js';
import { MESSAGING_SETTINGS } from './messaging.settings.js';
import { SmsInboundController } from './sms-inbound.controller.js';
import { MessagingPersonalData } from './messaging.personal-data.js';

/**
 * SMS and mobile push (README.md): a person's devices and verified number,
 * the queue a worker sends from within the toll-fraud caps, and the SMS
 * provider's signed STOP/START webhook. `MessagingSender` is what the
 * notification delivery calls. Needs QueuesModule, RedisModule,
 * EncryptionModule, MetricsModule, DatabaseModule and TenancyModule.
 */
@Module({
  imports: [
    ConfigModule.forFeature(messagingConfig),
    ConfigModule.forFeature(httpConfig),
    AccessModule.forFeature(MESSAGING_PERMISSIONS),
    AuditModule,
    SettingsModule.forFeature(MESSAGING_SETTINGS),
    SharedHttpClientModule,
    BullModule.registerQueue({
      name: MESSAGING,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    ...messagingClients(),
  ],
  controllers: [MessagingController, SmsInboundController],
  providers: [
    smsProvider,
    pushProvider,
    MessagingService,
    MessagingRepository,
    MessagingLimits,
    MessagingProcessor,
    MessagingRetentionJob,
    MessagingSender,
    MessagingPersonalData,
  ],
  exports: [MessagingSender],
})
export class MessagingModule {}
