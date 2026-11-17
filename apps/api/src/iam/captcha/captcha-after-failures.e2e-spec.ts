import { randomInt, randomUUID } from 'node:crypto';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { accessModules } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { CaptchaModule } from './captcha.module.js';
import { ProbeModule } from './captcha-stand-in.js';

// after-failures with the stub verifier (tokens judged by their text).
vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-captcha-af-${process.pid}-${Date.now()}`,
    NODE_ENV: 'test',
    CAPTCHA_MODE: 'after-failures',
    CAPTCHA_PROVIDER: 'stub',
    CAPTCHA_FAILURES: '3',
  });
});

const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const pass = () => `stub:pass:${randomUUID()}`;

describe('bot protection, after failures (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      MetricsModule,
      CaptchaModule,
      ProbeModule,
    );
  });
  afterAll(async () => {
    await app.close();
  });

  const signIn = (
    address: string,
    email: string,
    password: string,
    token?: string,
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/probe/sign-in',
      headers: {
        'x-forwarded-for': address,
        ...(token && { 'x-captcha-token': token }),
      },
      payload: { email, password },
    });
  const email = () => `${randomUUID().slice(0, 8)}@example.com`;

  it('lets the first CAPTCHA_FAILURES wrong attempts through, then asks for a token', async () => {
    const address = ip();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await signIn(address, email(), 'wrong')).statusCode).toBe(401);
    }
    const asked = await signIn(address, email(), 'right');
    expect(asked.statusCode).toBe(403);
    expect(asked.json()).toMatchObject({
      code: 'captcha_required',
      provider: 'stub',
      action: 'sign-in',
    });
    expect((await signIn(address, email(), 'right', pass())).statusCode).toBe(
      200,
    );
    const spent = await signIn(address, email(), 'right', 'stub:spent:x');
    expect(spent.json()).toMatchObject({
      code: 'captcha_invalid',
      reason: 'duplicate',
    });
  });

  it('gives back an attempt that succeeded: right passwords never trip the challenge', async () => {
    const address = ip();
    for (let attempt = 0; attempt < 6; attempt++) {
      expect((await signIn(address, email(), 'right')).statusCode).toBe(200);
    }
  });

  it('counts per account too: wrong attempts at one email from several addresses', async () => {
    const target = email();
    for (let attempt = 0; attempt < 3; attempt++) {
      await signIn(ip(), target, 'wrong');
    }
    // Each address is new, and the account's own key is per email and address:
    // the same address is asked after its own failures.
    const address = ip();
    for (let attempt = 0; attempt < 3; attempt++) {
      await signIn(address, target, 'wrong');
    }
    expect((await signIn(address, target, 'right')).statusCode).toBe(403);
  });

  it('counts every request on a "requests" route, whatever the answer', async () => {
    const address = ip();
    const forgot = () =>
      app.inject({
        method: 'POST',
        url: '/v1/probe/forgot',
        headers: { 'x-forwarded-for': address },
        payload: { email: email() },
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await forgot()).statusCode).toBe(202);
    }
    expect((await forgot()).statusCode).toBe(403);
  });
});
