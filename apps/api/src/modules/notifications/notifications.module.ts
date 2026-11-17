import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { httpConfig } from '../../core/http/http.config.js';
import { MailModule } from '../../core/mail/mail.module.js';
import { observabilityConfig } from '../../core/observability/observability.config.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import {
  NotificationCatalog,
  NotificationRegistration,
} from './notifications.catalog.js';
import { notificationsConfig } from './notifications.config.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationDelivery } from './notifications.delivery.js';
import { DevicesController } from './notifications.devices.controller.js';
import { DevicesService } from './notifications.devices.service.js';
import { NotificationDigestJob } from './notifications.digest.job.js';
import {
  NotificationDigestMail,
  NotificationMail,
} from './notifications.mails.js';
import { NotificationPreferencesService } from './notifications.preferences.service.js';
import { PUSH_QUEUE, WebPush, WebPushTransport } from './notifications.push.js';
import { PushProcessor } from './notifications.push.processor.js';
import { NotificationRetentionJob } from './notifications.retention.job.js';
import { NotificationsService } from './notifications.service.js';
import { UnsubscribeLinks } from './notifications.unsubscribe.js';
import { UnsubscribeController } from './notifications.unsubscribe.controller.js';
import { UnsubscribeService } from './notifications.unsubscribe.service.js';
import { TEST_NOTIFICATIONS } from './notifications.test.js';
import type { NotificationTypeDeclaration } from './notifications.types.js';
import { SubscriptionsController } from './subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * Notifications and watching records (README.md): the routes under
 * /notifications, /devices and /subscriptions, `NotificationsService.notify()`
 * for the modules that tell people things, the delivery on a worker (in-app,
 * realtime, mail and digests, web push), the nightly retention. Needs
 * AuthModule and EncryptionModule (global), SecretsModule, SharedOutboxModule,
 * QueuesModule and the tenancy and database modules.
 *
 * A module declares its types in its own imports,
 * `NotificationsModule.forFeature(NOTE_NOTIFICATIONS)`.
 */
@Module({
  imports: [
    ConfigModule.forFeature(notificationsConfig),
    ConfigModule.forFeature(httpConfig),
    ConfigModule.forFeature(observabilityConfig),
    AccessModule,
    AuditModule,
    DiscoveryModule,
    MailModule,
    RealtimeModule,
    BullModule.registerQueue({
      name: PUSH_QUEUE,
      defaultJobOptions: {
        ...DEFAULT_JOB_OPTIONS,
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    }),
  ],
  controllers: [
    NotificationsController,
    UnsubscribeController,
    DevicesController,
    SubscriptionsController,
  ],
  providers: [
    // The test notification of `POST /notifications/test`, declared where that route is on.
    {
      provide: NotificationRegistration,
      inject: [notificationsConfig.KEY],
      useFactory: (config: ConfigType<typeof notificationsConfig>) =>
        new NotificationRegistration(
          config.testRoute ? TEST_NOTIFICATIONS : [],
        ),
    },
    NotificationCatalog,
    NotificationsService,
    NotificationPreferencesService,
    NotificationDelivery,
    NotificationDigestJob,
    NotificationRetentionJob,
    NotificationMail,
    NotificationDigestMail,
    UnsubscribeLinks,
    UnsubscribeService,
    DevicesService,
    WebPush,
    WebPushTransport,
    PushProcessor,
    SubscriptionsService,
  ],
  exports: [NotificationsService, SubscriptionsService],
})
export class NotificationsModule {
  /**
   * Declares a module's notification types (`defineNotifications()`). Import
   * it in the module that owns the types; the catalog finds every declaration
   * at startup and refuses a duplicate, a malformed name, or a type the
   * catalogs have no texts for.
   */
  static forFeature(
    types: readonly NotificationTypeDeclaration<any>[],
  ): DynamicModule {
    return {
      module: NotificationsFeatureModule,
      providers: [
        {
          provide: NotificationRegistration,
          useValue: new NotificationRegistration(types),
        },
      ],
    };
  }
}

/** The host of one `NotificationsModule.forFeature()` declaration. */
@Module({})
class NotificationsFeatureModule {}
