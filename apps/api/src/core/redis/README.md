# core/redis

The shared Redis connection (ioredis, Redis 7 or later). `RedisModule` is global.

- **Use:** `@Inject(REDIS)` is the client; every key is prefixed with `REDIS_PREFIX:`. `RedisService.ping()` is true while Redis answers (a PING within 2 s, never throws). It is closed last on shutdown, without ever hanging it (`closeRedis()`).
- **Readiness:** the `redis` check of core/health uses `ping()`.
- **BullMQ and others** build their own connections from `redisOptions()` / `producerRedisOptions()` (`redis.ts`): a producer fails fast while Redis is away (no offline queue), a worker waits for it.
- `rediss://` turns TLS on; the URL path is the database number; REDIS_SENTINELS switches to Sentinel (REDIS_URL then gives the password, database and TLS).

Variables (`redis.config.ts`): REDIS_URL, REDIS_PASSWORD (both secrets: `_FILE` works), REDIS_SENTINELS, REDIS_SENTINEL_NAME, REDIS_PREFIX.

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
