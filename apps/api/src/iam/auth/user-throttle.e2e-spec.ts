import { Controller, Get, Module, VERSION_NEUTRAL } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { SkipThrottle } from '@nestjs/throttler';
import { Can } from '@nestjs/authorization';
import { authModules, signedInUser } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';

// Read when the module loads: before the imports run.
vi.hoisted(() => {
  process.env.RATE_LIMIT_PER_CALLER = '2';
});

@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  @Get('plain')
  @Can.Anyone()
  plain() {
    return { ok: true };
  }

  @Get('skipped')
  @Can.Anyone()
  @SkipThrottle()
  skipped() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('the default limit per signed-in caller (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(...authModules(), ProbeModule);
  });
  afterAll(async () => {
    await app.close();
  });

  it('counts every route per caller, not per address', async () => {
    const one = await signedInUser(app);
    const hit = (headers: Record<string, string>, url = '/probe/plain') =>
      app.inject({ method: 'GET', url, headers });
    expect((await hit(one.headers)).statusCode).toBe(200);
    expect((await hit(one.headers)).statusCode).toBe(200);
    const refused = await hit(one.headers);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after-user']).toBeDefined();
    // Another user from the same address has a counter of their own.
    const other = await signedInUser(app);
    expect((await hit(other.headers)).statusCode).toBe(200);
  });

  it('skips a route that skips throttling', async () => {
    const { headers } = await signedInUser(app);
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/probe/skipped',
        headers,
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
