import { randomInt, randomUUID } from 'node:crypto';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { accessModules } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { CaptchaModule } from './captcha.module.js';
import { ProbeModule } from './captcha-stand-in.js';

// Fail-closed: a provider that is down or hangs refuses the request, and the
// breaker opens after a run of failures.
const siteverify = await vi.hoisted(async () => {
  const { startSiteverify } = await import('./captcha-stand-in.js');
  const stand = await startSiteverify();
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-captcha-outage-${process.pid}-${Date.now()}`,
    CAPTCHA_MODE: 'always',
    CAPTCHA_ON_ERROR: 'reject',
  });
  return stand;
});

const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('bot protection, provider outage, fail-closed (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      MetricsModule,
      CaptchaModule,
      ProbeModule,
    );
  });
  beforeEach(() => siteverify.reset());
  afterAll(async () => {
    await app.close();
    await siteverify.close();
  });

  const forgot = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/probe/forgot',
      headers: { 'x-forwarded-for': ip(), 'x-captcha-token': token },
      payload: { email: `${randomUUID().slice(0, 8)}@example.com` },
    });

  it('answers 503 captcha_unavailable when the provider fails, and again when it hangs past the timeout', async () => {
    siteverify.state.down = true;
    const down = await forgot(siteverify.token());
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      code: 'captcha_unavailable',
      retryAfter: 30,
    });
    siteverify.reset();
    siteverify.state.hang = true;
    expect((await forgot(siteverify.token())).statusCode).toBe(503);
  });

  it('opens the breaker after repeated failures: no more calls to the provider, and a request without a token is 503 too', async () => {
    siteverify.state.down = true;
    for (let attempt = 0; attempt < 6; attempt++) {
      await forgot(siteverify.token());
    }
    siteverify.requests.length = 0;
    expect((await forgot(siteverify.token())).statusCode).toBe(503);
    expect(siteverify.requests).toHaveLength(0);
    const noToken = await app.inject({
      method: 'POST',
      url: '/v1/probe/forgot',
      headers: { 'x-forwarded-for': ip() },
      payload: {},
    });
    expect(noToken.statusCode).toBe(503);
  });
});
