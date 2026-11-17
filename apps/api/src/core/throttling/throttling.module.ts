import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { minutes, ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.js';
import { RedisModule } from '../redis/redis.module.js';
import { ScaledThrottlerGuard } from './scaled-throttler.guard.js';
import { throttlingConfig } from './throttling.config.js';

/**
 * Rate limiting (@nestjs/throttler) on every route: 600 requests a minute
 * per IP (the address the HTTP adapter resolved behind the trusted proxies),
 * counted in Redis so the limit holds across instances. A route tightens it
 * with `@Throttle({ default: { limit, ttl } })` and skips it with
 * `@SkipThrottle()` (health does). Over the limit: 429 `rate_limited` with
 * Retry-After, as problem details (the ThrottlerException goes through
 * ProblemDetailsFilter). Every limit is multiplied by RATE_LIMIT_MULTIPLIER.
 */
@Module({
  imports: [
    ConfigModule.forFeature(throttlingConfig),
    RedisModule,
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule.forFeature(throttlingConfig), RedisModule],
      inject: [throttlingConfig.KEY, REDIS],
      useFactory: (
        config: ConfigType<typeof throttlingConfig>,
        redis: Redis,
      ) => ({
        throttlers: [{ ttl: minutes(1), limit: 600 }],
        errorMessage: 'Too many requests: try again later.',
        storage:
          config.store === 'redis'
            ? new ThrottlerStorageRedisService(redis)
            : undefined,
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ScaledThrottlerGuard }],
})
export class ThrottlingModule {}
