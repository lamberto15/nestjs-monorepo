import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseModule } from './core/database/database.module.js';
import { EncryptionModule } from './core/encryption/encryption.module.js';
import { HealthModule } from './core/health/health.module.js';
import { SharedHttpClientModule } from './core/http-client/http-client.module.js';
import { HttpConventionsModule } from './core/http/http-conventions.module.js';
import { I18nModule } from './core/i18n/i18n.module.js';
import { SharedIdempotencyModule } from './core/idempotency/idempotency.module.js';
import { JobsModule } from './core/jobs/jobs.module.js';
import { SharedLocksModule } from './core/locks/locks.module.js';
import { LoggingModule } from './core/logging/logging.module.js';
import { MailModule } from './core/mail/mail.module.js';
import { MetricsModule } from './core/metrics/metrics.module.js';
import { ObservabilityModule } from './core/observability/observability.module.js';
import { SharedOutboxModule } from './core/outbox/outbox.module.js';
import { QueuesModule } from './core/queues/queues.module.js';
import { RedisModule } from './core/redis/redis.module.js';
import { SecretsModule } from './core/secrets/secrets.module.js';
import { TenancyModule } from './core/tenancy/tenancy.module.js';
import { ThrottlingModule } from './core/throttling/throttling.module.js';
import { SharedWorkflowsModule } from './core/workflows/workflows.module.js';
import { AccessModule } from './iam/access/access.module.js';
import { AuditModule } from './iam/audit/audit.module.js';
import { AuthModule } from './iam/auth/auth.module.js';
import { CaptchaModule } from './iam/captcha/captcha.module.js';
import { OrganizationModule } from './iam/organization/organization.module.js';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module.js';
import { ImagesModule } from './modules/images/images.module.js';
import { PresenceModule } from './modules/presence/presence.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { StorageModule } from './modules/storage/storage.module.js';

/**
 * Every module of the app, listed here and nowhere else. A module owns its
 * routes, tables, environment variables and tests, so removing one is
 * deleting its folder and its line below (AGENTS.md, "Rules").
 */
@Module({
  imports: [
    // Loads .env into process.env; each module reads and checks its own
    // variables in its *.config.ts.
    ConfigModule.forRoot(),
    // Events inside the process: how modules of one level talk.
    EventEmitterModule.forRoot(),
    // Core: always there.
    LoggingModule,
    MetricsModule,
    ObservabilityModule,
    HttpConventionsModule,
    ThrottlingModule,
    I18nModule,
    DatabaseModule,
    TenancyModule,
    RedisModule,
    QueuesModule,
    SharedLocksModule,
    EncryptionModule,
    SecretsModule,
    MailModule,
    HealthModule,
    SharedOutboxModule,
    SharedWorkflowsModule,
    JobsModule,
    // Global interceptors run in the order their modules are listed.
    // Idempotency comes before every interceptor that does work: a replayed
    // response is neither metered nor retried. Usage metering (when ported)
    // goes between these two; the retries of outbound calls are the
    // innermost. Only the two that set a request's context (its language,
    // I18nModule; nestjs-cls) stay outside it, which its boot warning names.
    SharedIdempotencyModule,
    SharedHttpClientModule,
    // Identity and access. Global guards run in the order their modules are
    // listed: the rate limit (ThrottlingModule, above), then who is calling
    // (AuthModule), then what they may do.
    AuthModule,
    AuditModule,
    // Its guard refuses a route that declares no check (@Can(), @Can.Anyone()
    // or @Public()).
    AccessModule,
    OrganizationModule,
    CaptchaModule,
    // Optional capabilities.
    StorageModule,
    ImagesModule,
    ClientErrorsModule,
    RealtimeModule,
    PresenceModule,
  ],
})
export class AppModule {}
