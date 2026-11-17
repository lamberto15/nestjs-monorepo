import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import { SharedHttpClientModule } from '../../core/http-client/http-client.module.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { OperatorGuard } from '../../iam/auth/operator-only.js';
import { SuppressionsController } from './deliverability.controller.js';
import { deliverabilityConfig } from './deliverability.config.js';
import { DELIVERABILITY_PERMISSIONS } from './deliverability.permissions.js';
import { MailSuppressionPolicy } from './deliverability.policy.js';
import { PostmarkIntake } from './intake/postmark.intake.js';
import { ResendIntake } from './intake/resend.intake.js';
import { SendGridIntake } from './intake/sendgrid.intake.js';
import { SesIntake } from './intake/ses.intake.js';
import { HttpSnsGateway, SnsGateway, SNS_HTTP } from './intake/sns-gateway.js';
import { MAIL_EVENTS } from './mail-event.types.js';
import { MailEventsController } from './mail-events.controller.js';
import { MailEventsProcessor } from './mail-events.processor.js';
import { MailEventsRetentionJob } from './mail-events.retention.job.js';
import { MailEventsService } from './mail-events.service.js';
import { SuppressionsService } from './suppressions.service.js';

/**
 * Email deliverability (README.md): the providers' bounce and complaint
 * webhooks, the suppression list, and the operators' routes over it.
 * SuppressionsService is what core/mail's worker asks before every send
 * (`@MailSuppressionList()`, found by discovery). Needs QueuesModule, MetricsModule, DatabaseModule,
 * TenancyModule and what AccessModule needs.
 */
@Module({
  imports: [
    ConfigModule.forFeature(deliverabilityConfig),
    AccessModule.forFeature(DELIVERABILITY_PERMISSIONS),
    AuditModule,
    SharedHttpClientModule,
    BullModule.registerQueue({
      name: MAIL_EVENTS,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    // SNS: signing certificates and subscription confirmations, at URLs the
    // intake has checked are SNS's own. No base URL (the region is the
    // message's); one short attempt, SNS retries.
    HttpClientModule.register({
      name: SNS_HTTP,
      timeout: '5s',
      retry: false,
      redirect: 'error',
    }),
  ],
  controllers: [MailEventsController, SuppressionsController],
  providers: [
    { provide: SnsGateway, useClass: HttpSnsGateway },
    SesIntake,
    PostmarkIntake,
    ResendIntake,
    SendGridIntake,
    MailEventsService,
    MailEventsProcessor,
    MailEventsRetentionJob,
    SuppressionsService,
    MailSuppressionPolicy,
    OperatorGuard,
  ],
})
export class DeliverabilityModule {}
