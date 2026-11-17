import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { list, optional, secret, withDefault } from '../config/env.helpers.js';

export const schema = z.object({
  /** Redis 7 or later. `rediss://` turns TLS on; the path is the database number. */
  REDIS_URL: secret(withDefault('redis://127.0.0.1:6379')),
  /** Replaces the URL's password: for one kept in a file (REDIS_PASSWORD_FILE). */
  REDIS_PASSWORD: secret(optional()),
  /**
   * Redis behind Sentinel, for failover: `host:port` of each sentinel
   * (comma-separated), and the monitored master's name. REDIS_URL then only
   * gives the password, the database number and TLS.
   */
  REDIS_SENTINELS: list(),
  REDIS_SENTINEL_NAME: withDefault('mymaster'),
  /** Prefix of every key and queue this app writes, so apps can share a Redis. */
  REDIS_PREFIX: withDefault('app'),
});

export const redisConfig = registerAs('redis', () => {
  const env = readEnv(schema);
  return {
    url: env.REDIS_URL,
    password: env.REDIS_PASSWORD,
    sentinels: env.REDIS_SENTINELS,
    sentinelName: env.REDIS_SENTINEL_NAME,
    prefix: env.REDIS_PREFIX,
  };
});
