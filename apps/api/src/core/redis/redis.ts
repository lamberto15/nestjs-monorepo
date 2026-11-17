import { setTimeout } from 'node:timers/promises';
import type { ConfigType } from '@nestjs/config';
import type { Redis, RedisOptions } from 'ioredis';
import type { redisConfig } from './redis.config.js';

/** The app's Redis connection (ioredis). Keys are prefixed with `REDIS_PREFIX:`. */
export const REDIS = Symbol('REDIS');

export type RedisSettings = ConfigType<typeof redisConfig>;

/**
 * REDIS_URL (or REDIS_SENTINELS) as ioredis connection options, shared by
 * every client: the app's and BullMQ's (which takes a `prefix` instead of a
 * key prefix).
 */
export function redisOptions(settings: RedisSettings): RedisOptions {
  const url = new URL(settings.url);
  return {
    ...(settings.sentinels.length > 0
      ? {
          sentinels: settings.sentinels.map((sentinel) => {
            const [host, port] = sentinel.split(':');
            return { host, port: Number(port || 26379) };
          }),
          name: settings.sentinelName,
        }
      : { host: url.hostname, port: Number(url.port || 6379) }),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password:
      settings.password ??
      (url.password ? decodeURIComponent(url.password) : undefined),
    db: Number(url.pathname.slice(1) || 0),
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // Commands wait for a reconnect instead of failing at once (BullMQ's
    // workers require it; BullMQ also forces it on every blocking
    // connection of a Worker or QueueEvents it creates from these options).
    maxRetriesPerRequest: null,
  };
}

/** Reconnect delay of the producer connection: 50 ms per attempt, 2 s at most (ioredis's default). */
const producerRetryStrategy = (times: number) => Math.min(times * 50, 2000);

/**
 * The connection options of BullMQ's `Queue` instances (what `queue.add()`
 * runs on), as BullMQ's production guide recommends for producers: no
 * offline queue, so a command issued while Redis is unreachable is rejected
 * at once instead of being buffered and sent when Redis returns (a request
 * that gave up must not leave a job that runs later), and one retry per
 * command. Workers keep `redisOptions()`'s `null`: they must wait for Redis
 * (https://docs.bullmq.io/guide/going-to-production).
 */
export function producerRedisOptions(settings: RedisSettings): RedisOptions {
  return {
    ...redisOptions(settings),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // With no offline queue, every add fails while the client is not ready:
    // ioredis's steps keep that window short after a drop (BullMQ's own
    // default waits at least 1 s between attempts).
    retryStrategy: producerRetryStrategy,
  };
}

/**
 * Closes an ioredis client without ever hanging a shutdown. `quit()` sends
 * QUIT after the commands already queued; with `maxRetriesPerRequest:
 * null`, those wait for a reconnect that never comes once Redis is gone, and
 * so does the QUIT (seen: SIGTERM after Redis was removed, the process never
 * exited). So: connected, `quit()` lets pending replies arrive, for at most
 * `timeoutMs`; not connected, nothing can be flushed anyway and
 * `disconnect()` closes at once, dropping the queue and stopping the
 * reconnect loop.
 */
export async function closeRedis(client: Redis, timeoutMs = 2000) {
  if (client.status === 'ready') {
    const gaveUp = Symbol('timeout');
    const result = await Promise.race([
      client.quit().catch(() => gaveUp),
      // ref: false, so a finished quit doesn't leave the process waiting for it.
      setTimeout(timeoutMs, gaveUp, { ref: false }),
    ]);
    if (result !== gaveUp) {
      return;
    }
  }
  if (client.status !== 'end') {
    client.disconnect();
  }
}

/**
 * Whether Redis answers a PING within `timeoutMs`: connected and responsive,
 * not just a socket that is still open to a server that stopped answering.
 */
export async function redisResponds(client: Redis, timeoutMs = 2000) {
  if (client.status !== 'ready') {
    return false;
  }
  return Promise.race([
    client.ping().then(
      () => true,
      () => false,
    ),
    setTimeout(timeoutMs, false, { ref: false }),
  ]);
}
