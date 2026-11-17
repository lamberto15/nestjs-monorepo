import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './core/database/database.module.js';
import { EncryptionModule } from './core/encryption/encryption.module.js';
import { HealthModule } from './core/health/health.module.js';
import { HttpConventionsModule } from './core/http/http-conventions.module.js';
import { I18nModule } from './core/i18n/i18n.module.js';
import { SharedLocksModule } from './core/locks/locks.module.js';
import { LoggingModule } from './core/logging/logging.module.js';
import { MailModule } from './core/mail/mail.module.js';
import { MetricsModule } from './core/metrics/metrics.module.js';
import { ObservabilityModule } from './core/observability/observability.module.js';
import { QueuesModule } from './core/queues/queues.module.js';
import { RedisModule } from './core/redis/redis.module.js';
import { TenancyModule } from './core/tenancy/tenancy.module.js';
import { ThrottlingModule } from './core/throttling/throttling.module.js';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module.js';
import { ImagesModule } from './modules/images/images.module.js';
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
    MailModule,
    HealthModule,
    // Optional capabilities.
    StorageModule,
    ImagesModule,
    ClientErrorsModule,
  ],
})
export class AppModule {}
