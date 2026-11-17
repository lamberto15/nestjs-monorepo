import { Global, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Redis } from 'ioredis';
import { redisConfig } from './redis.config.js';
import { REDIS, redisOptions } from './redis.js';
import { RedisReadiness } from './redis.readiness.js';
import { RedisService } from './redis.service.js';

/**
 * The shared Redis connection: inject the client with `@Inject(REDIS)`, or
 * `RedisService` for `ping()` (the readiness check). Closed on shutdown.
 */
@Global()
@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [
    {
      provide: REDIS,
      inject: [redisConfig.KEY],
      useFactory: (config: ConfigType<typeof redisConfig>) =>
        new Redis({ ...redisOptions(config), keyPrefix: `${config.prefix}:` }),
    },
    RedisService,
    RedisReadiness,
  ],
  exports: [REDIS, RedisService],
})
export class RedisModule {}
