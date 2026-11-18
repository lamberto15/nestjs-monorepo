import { type DynamicModule, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import {
  WebhooksModule as NestWebhooksModule,
  WebhooksStorage,
} from '@nestjs/webhooks';
import { fromDrizzle, PostgresWebhookStore } from '@nestjs/webhooks/postgres';
import type { Database } from '../../core/database/database.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { encryptionConfig } from '../../core/encryption/encryption.config.js';
import { OnDomainEvent } from '../../core/outbox/events.js';
import { queuesConfig, runsWorkers } from '../../core/queues/queues.config.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { switchFeature } from '../../core/http/feature.js';
import { authConfig } from '../../iam/auth/auth.config.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import { recordEvents } from '../records/record.events.js';
import { recordSchemas } from '../records/record.schemas.js';
import { ClientWebhooksController } from './client-webhooks.controller.js';
import { IncomingEventTypesController } from './incoming-event-types.controller.js';
import { IncomingEventHandlers } from './incoming-events.js';
import { IncomingSendersController } from './incoming-senders.controller.js';
import { IncomingSendersService } from './incoming-senders.service.js';
import {
  TENANT_SENDERS_RECEIVER,
  TenantSenderScheme,
} from './tenant-sender.scheme.js';
import { TenantSenderGuard } from './tenant-sender.guard.js';
import { TenantWebhookReceiverController } from './tenant-webhook-receiver.controller.js';
import { WebhookCatalog } from './webhook-catalog.js';
import { WebhookDeliveriesController } from './webhook-deliveries.controller.js';
import { WebhookDeliveryRetentionJob } from './webhook-delivery-retention.job.js';
import { SecurityWebhooks } from './webhooks.security.js';
import { WebhookMetrics } from './webhook-metrics.js';
import { WebhookEndpointsController } from './webhook-endpoints.controller.js';
import { type WebhookEvent, WebhookEvents } from './webhook-events.js';
import { WebhookEventTypesController } from './webhook-event-types.controller.js';
import { WebhookPublisher } from './webhook-publisher.js';
import { deliveryOptions, SafeWebhookTransport } from './webhook.transport.js';
import { webhooksConfig } from './webhooks.config.js';
import './webhooks.errors.js';
import { WEBHOOK_PERMISSIONS } from './webhooks.permissions.js';
import { WebhookPolicy } from './webhooks.policy.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * Outgoing webhooks of API clients (subscriptions, signed and retried
 * deliveries, the delivery log) and signed incoming webhooks of a tenant's
 * senders, on @nestjs/webhooks (README.md). A module's domain event becomes
 * a webhook through `WebhooksModule.forFeature()` in that module's imports.
 * Needs the core (database, tenancy, outbox, encryption, locks), AuthModule,
 * AccessModule and EventEmitterModule.
 */
@Module({
  imports: [
    ConfigModule.forFeature(webhooksConfig),
    // The API_CLIENTS switch of the routes managing a client's webhooks.
    ConfigModule.forFeature(authConfig),
    ConfigModule.forFeature(queuesConfig),
    DiscoveryModule,
    MetricsModule,
    AccessModule.forFeature(WEBHOOK_PERMISSIONS),
    AuditModule,
    NestWebhooksModule.forRootAsync({
      // Every delivery through safeFetch's address rules, recorded for the log.
      transport: SafeWebhookTransport,
      imports: [
        ConfigModule.forFeature(webhooksConfig),
        ConfigModule.forFeature(encryptionConfig),
        ConfigModule.forFeature(queuesConfig),
      ],
      inject: [webhooksConfig.KEY, encryptionConfig.KEY, queuesConfig.KEY],
      useFactory: (
        webhooks: ConfigType<typeof webhooksConfig>,
        encryption: ConfigType<typeof encryptionConfig>,
        queues: ConfigType<typeof queuesConfig>,
      ) => ({
        // Up to about 44 hours of retries: waits grow ×4 from 5 s to a 1 h cap, then hourly.
        retry: {
          attempts: 50,
          backoff: { delay: '5s', factor: 4, maxDelay: '1h' },
        },
        // An endpoint that fails every attempt for five days is switched off.
        disableEndpointAfter: '5d',
        delivery: { timeout: '15s', ...deliveryOptions(webhooks) },
        worker: {
          enabled: webhooks.worker && runsWorkers(queues.role),
          pollInterval: '1s',
        },
        // Endpoint secrets at rest, under the deployment's data keys (the
        // package derives its own key from each). Without keys the boot
        // already fails: the senders' secrets are encrypted columns.
        ...(encryption.dataKeys.length > 0 && {
          encryption: { keys: encryption.dataKeys },
        }),
        receivers: {
          // The tenants' senders: their secrets are in the database, handed to
          // the scheme per request (TenantSenderGuard); this one verifies nothing.
          [TENANT_SENDERS_RECEIVER]: {
            scheme: new TenantSenderScheme(),
            secret: TENANT_SENDERS_RECEIVER,
          },
        },
      }),
    }),
  ],
  controllers: [
    WebhookEndpointsController,
    WebhookDeliveriesController,
    WebhookEventTypesController,
    ClientWebhooksController,
    IncomingSendersController,
    IncomingEventTypesController,
    TenantWebhookReceiverController,
  ],
  providers: [
    {
      // Endpoints, messages, deliveries and their log, in nest_webhooks: the
      // app's role may not create tables, so the schema is a migration.
      provide: PostgresWebhookStore,
      inject: [getDrizzleToken(), WebhooksStorage],
      useFactory: (db: Database, storage: WebhooksStorage) =>
        new PostgresWebhookStore(
          { executor: fromDrizzle(db), migrate: false },
          storage,
        ),
    },
    WebhookCatalog,
    WebhookPublisher,
    WebhooksService,
    WebhookPolicy,
    IncomingSendersService,
    IncomingEventHandlers,
    TenantSenderGuard,
    WebhookDeliveryRetentionJob,
    WebhookMetrics,
    SecurityWebhooks,
    switchFeature(
      'webhooks',
      'Webhook endpoints and their deliveries (`/v1/webhook-endpoints`).',
    ),
  ],
  exports: [WebhookPublisher],
})
export class WebhooksModule {
  /**
   * Makes these domain events webhooks API clients may subscribe to, from
   * the module that owns them: each is relayed in the worker, in its
   * tenant, to the clients allowed to read it (WebhookPublisher), and
   * listed in `GET /v1/webhook-event-types`.
   *
   * ```ts
   * @Module({ imports: [WebhooksModule.forFeature([{ event: noteCreated, subject: 'Note', description: 'A note was created.', data: noteWebhookSchema }])] })
   * ```
   */
  static forFeature(events: readonly WebhookEvent<any>[]): DynamicModule {
    // One class per registration: the outbox finds its handlers on a
    // provider's methods, and the catalog its events on the class.
    @WebhookEvents(events)
    @Injectable()
    class WebhookEventRelay {
      constructor(
        @Inject(WebhookPublisher) readonly publisher: WebhookPublisher,
      ) {}
    }
    for (const definition of events) {
      const method = `relay ${definition.event.type}`;
      const descriptor: PropertyDescriptor = {
        value(
          this: WebhookEventRelay,
          payload: unknown,
          ctx: OutboxHandlerContext,
        ) {
          return this.publisher.publish(definition, payload, ctx);
        },
        writable: true,
        configurable: true,
      };
      OnDomainEvent(definition.event, { consumer: 'webhooks-relay' })(
        WebhookEventRelay.prototype,
        method,
        descriptor,
      );
      Object.defineProperty(WebhookEventRelay.prototype, method, descriptor);
    }
    return {
      module: WebhookEventsModule,
      imports: [WebhooksModule],
      providers: [WebhookEventRelay],
    };
  }

  /**
   * A record's created, updated, deleted and restored events as webhooks
   * (`testItem.created`…): the feature's own import, no event written. `data`
   * is the record as the API shows it (no add-on's keys, no `can`); a
   * client receives it only for a record it may read, redacted as for a read.
   *
   * ```ts
   * imports: [WebhooksModule.forRecord(INVOICE)]
   * ```
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    const data = recordSchemas(record).response.omit({ can: true });
    const events = recordEvents(record);
    const noun = aNoun(record);
    return WebhooksModule.forFeature(
      (['created', 'updated', 'deleted', 'restored'] as const).map((name) => ({
        event: events[name],
        subject: record.subject,
        description: `${noun[0]!.toUpperCase()}${noun.slice(1)} was ${name}.`,
        data,
        record: true,
      })),
    );
  }
}

/** The host of one `WebhooksModule.forFeature()` registration. */
@Module({})
class WebhookEventsModule {}
