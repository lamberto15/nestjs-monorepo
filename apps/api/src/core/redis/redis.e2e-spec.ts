import { once } from 'node:events';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { REDIS } from './redis.js';
import { RedisModule } from './redis.module.js';
import { RedisService } from './redis.service.js';

/** ioredis connects in the background: wait for it, as a request after startup would. */
const ready = async (redis: Redis) => {
  if (redis.status !== 'ready') await once(redis, 'ready');
};

describe('redis', () => {
  const prefix = `test-redis-${process.pid}`;
  let moduleRef: Awaited<
    ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>
  >;

  beforeAll(async () => {
    process.env.REDIS_PREFIX = prefix;
    moduleRef = await Test.createTestingModule({
      imports: [RedisModule],
    }).compile();
    await moduleRef.init();
    await ready(moduleRef.get<Redis>(REDIS));
  });

  afterAll(async () => {
    await moduleRef.get<Redis>(REDIS).del('probe');
    await moduleRef.close();
    delete process.env.REDIS_PREFIX;
  });

  it('ping() is true while Redis answers', async () => {
    await expect(moduleRef.get(RedisService).ping()).resolves.toBe(true);
  });

  it('prefixes every key with REDIS_PREFIX', async () => {
    const redis = moduleRef.get<Redis>(REDIS);
    await redis.set('probe', '1');
    const raw = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    try {
      expect(await raw.get(`${prefix}:probe`)).toBe('1');
    } finally {
      raw.disconnect();
    }
  });

  it('closes the connection on shutdown, and ping() is then false', async () => {
    const standalone = await Test.createTestingModule({
      imports: [RedisModule],
    }).compile();
    await standalone.init();
    const redis = standalone.get<Redis>(REDIS);
    const service = standalone.get(RedisService);
    await ready(redis);
    await standalone.close();
    // QUIT is answered before the socket closes.
    if (redis.status !== 'end') await once(redis, 'end');
    expect(redis.status).toBe('end');
    await expect(service.ping()).resolves.toBe(false);
  });
});
