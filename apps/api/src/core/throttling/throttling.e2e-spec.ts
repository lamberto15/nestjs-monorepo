import { Controller, Get, Module, Post, VERSION_NEUTRAL } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { ThrottlingModule } from './throttling.module.js';

// Read when the module loads: before the imports run.
vi.hoisted(() => {
  process.env.RATE_LIMIT_MULTIPLIER = '2';
  process.env.REDIS_PREFIX = `test-throttling-${process.pid}`;
});

@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  @Get('limited')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  limited() {
    return { ok: true };
  }

  @Post('other')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  other() {
    return { ok: true };
  }

  @Get('skipped')
  @SkipThrottle()
  skipped() {
    return { ok: true };
  }
}

@Module({ imports: [ThrottlingModule], controllers: [ProbeController] })
class ProbeModule {}

describe('throttling (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(ProbeModule);
  });
  afterAll(async () => {
    await app.close();
    delete process.env.RATE_LIMIT_MULTIPLIER;
    delete process.env.REDIS_PREFIX;
  });

  it("raises a route's limit by RATE_LIMIT_MULTIPLIER and answers 429 problem details past it", async () => {
    for (let hit = 0; hit < 6; hit++) {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/limited',
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/probe/limited' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({
      status: 429,
      code: 'rate_limited',
      instance: '/probe/limited',
    });
  });

  it('counts each route on its own', async () => {
    const response = await app.inject({ method: 'POST', url: '/probe/other' });
    expect(response.statusCode).toBe(201);
  });

  it('never limits a route marked @SkipThrottle()', async () => {
    for (let hit = 0; hit < 10; hit++) {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/skipped',
      });
      expect(response.statusCode).toBe(200);
    }
  });
});
