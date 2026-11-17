import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { setTimeout } from 'node:timers/promises';
import { REDIS } from '../../core/redis/redis.js';
import {
  LIVE_TTL_SECONDS,
  TOTAL_FIELD,
  usageKey,
  utcDay,
} from './usage.keys.js';

/** How long a request waits for Redis before going on without its counters. */
const REDIS_TIMEOUT_MS = 500;

/**
 * The live counters: one Redis hash per client and UTC day, a field per
 * route and `_total`, copied every night into `api_usage` (UsageRollupJob).
 * A Redis outage lets requests through, uncounted (logged): metering never
 * takes the API down.
 */
@Injectable()
export class UsageCounters {
  private readonly logger = new Logger('Usage');

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /**
   * Counts one request: route and total in one round trip; the TTL is set by
   * the day's first increment. Fire and forget: an error is logged.
   * `total: false`: `take()` already took the total on entry.
   */
  count(
    client: { id: string; tenantId: string },
    route: string,
    total = true,
    at = new Date(),
  ) {
    if (this.redis.status !== 'ready') {
      this.logger.warn(`Usage not counted: Redis is ${this.redis.status}`);
      return;
    }
    const key = usageKey(client.tenantId, client.id, utcDay(at));
    const pipeline = this.redis.pipeline().hincrby(key, route, 1);
    if (total) {
      pipeline.hincrby(key, TOTAL_FIELD, 1);
    }
    pipeline
      .expire(key, LIVE_TTL_SECONDS, 'NX')
      .exec()
      .then((results) => {
        const failed = results?.find(([error]) => error)?.[0];
        if (failed) {
          throw failed;
        }
      })
      .catch((error: Error) =>
        this.logger.warn(`Usage not counted: ${error.message}`),
      );
  }

  /**
   * Takes one request of today's quota, atomically: the total goes up first,
   * and past the quota comes back down (a refused request isn't counted), so
   * a burst of parallel requests gets exactly `quota` through. `used` is
   * null when Redis could not be asked: allowed.
   */
  async take(
    client: { id: string; tenantId: string },
    quota: number,
    at = new Date(),
  ): Promise<{ allowed: boolean; used: number | null }> {
    const key = usageKey(client.tenantId, client.id, utcDay(at));
    const total = await this.fromRedis(
      'Quota not checked',
      async () => {
        const results = await this.redis
          .pipeline()
          .hincrby(key, TOTAL_FIELD, 1)
          .expire(key, LIVE_TTL_SECONDS, 'NX')
          .exec();
        const [error, value] = results![0]!;
        if (error) {
          throw error;
        }
        return Number(value);
      },
      null,
    );
    if (total === null) {
      return { allowed: true, used: null };
    }
    if (total > quota) {
      this.redis
        .hincrby(key, TOTAL_FIELD, -1)
        .catch((error: Error) =>
          this.logger.warn(`Quota count not given back: ${error.message}`),
        );
      return { allowed: false, used: quota };
    }
    return { allowed: true, used: total };
  }

  /** The routes' counts of each day's live hash (days not in Redis: empty). Unreachable Redis: none. */
  async live(tenantId: string, clientId: string, days: string[]) {
    const pipeline = this.redis.pipeline();
    for (const day of days) {
      pipeline.hgetall(usageKey(tenantId, clientId, day));
    }
    const replies = await this.fromRedis(
      'Live usage not read',
      async () => {
        const results = (await pipeline.exec()) ?? [];
        const failed = results.find(([error]) => error)?.[0];
        if (failed) {
          throw failed;
        }
        return results.map(([, hash]) => hash as Record<string, string>);
      },
      [] as Record<string, string>[],
    );
    return new Map(days.map((day, index) => [day, replies[index] ?? {}]));
  }

  /**
   * A read that never holds a request up: the shared client queues commands
   * until Redis is back, so a disconnected one answers `fallback` at once,
   * and a slow one after REDIS_TIMEOUT_MS; both logged.
   */
  private async fromRedis<T>(
    what: string,
    read: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    if (this.redis.status !== 'ready') {
      this.logger.warn(`${what}: Redis is ${this.redis.status}`);
      return fallback;
    }
    const gaveUp = Symbol('timeout');
    try {
      const result = await Promise.race([
        read(),
        // ref: false, so a pending timer never keeps the process alive.
        setTimeout(REDIS_TIMEOUT_MS, gaveUp, { ref: false }),
      ]);
      if (result === gaveUp) {
        this.logger.warn(`${what}: Redis took over ${REDIS_TIMEOUT_MS} ms`);
        return fallback;
      }
      return result as T;
    } catch (error) {
      this.logger.warn(`${what}: ${(error as Error).message}`);
      return fallback;
    }
  }
}
