import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { closeRedis, REDIS, redisResponds } from './redis.js';

/** What the rest of the app asks of the shared connection: is it answering, and closing it last. */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger('Redis');

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    // Without a listener, ioredis logs every failed attempt as an unhandled error event.
    redis.on('error', (error: Error) =>
      this.logger.warn(`Redis: ${error.message}`),
    );
  }

  /** Whether Redis answers a PING within `timeoutMs` (false, never a throw): for the readiness check. */
  ping(timeoutMs = 2000) {
    return redisResponds(this.redis, timeoutMs);
  }

  /** After everything that uses the connection has stopped. */
  async onApplicationShutdown() {
    await closeRedis(this.redis);
  }
}
