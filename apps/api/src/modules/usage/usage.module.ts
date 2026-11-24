import { Module } from '@nestjs/common';
import { UsageClientQuota } from './usage.client-quota.js';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { switchFeature } from '../../core/http/feature.js';
import { redisConfig } from '../../core/redis/redis.config.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { UsageCounters } from './usage.counters.js';
import { usageConfig } from './usage.config.js';
import { UsageController } from './usage.controller.js';
import { UsageInterceptor } from './usage.interceptor.js';
import { USAGE_PERMISSIONS } from './usage.permissions.js';
import { UsagePolicy } from './usage.policy.js';
import { UsageRepository } from './usage.repository.js';
import { UsageService } from './usage.service.js';
import { UsageRollupJob } from './usage-rollup.job.js';

/**
 * API usage metering (README.md). The meter is a global interceptor: its
 * place among them is this module's among AppModule's imports, after the
 * idempotency module (a replay is not counted) and before the outbound
 * HTTP module's retries.
 */
@Module({
  imports: [
    ConfigModule.forFeature(usageConfig),
    ConfigModule.forFeature(redisConfig),
    AccessModule.forFeature(USAGE_PERMISSIONS),
    AuditModule,
  ],
  controllers: [UsageController],
  providers: [
    UsageCounters,
    UsageService,
    UsageRepository,
    UsageRollupJob,
    UsagePolicy,
    UsageClientQuota,
    { provide: APP_INTERCEPTOR, useClass: UsageInterceptor },
    switchFeature(
      'usage',
      "Usage metering: API clients' usage (`/v1/access/clients/{id}/usage`) and `/v1/usage` (USAGE).",
      'usage.enabled',
    ),
  ],
  exports: [UsageService],
})
export class UsageModule {}
