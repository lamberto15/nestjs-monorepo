import { randomInt, randomUUID } from 'node:crypto';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { accessModules } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { recordMetrics } from '../../../test/metrics.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { CaptchaModule } from './captcha.module.js';
import { ProbeModule } from './captcha-stand-in.js';

// Read when the app boots: CAPTCHA_MODE=always against the siteverify
// stand-in with the real TurnstileVerifier; fail-open on an outage.
const siteverify = await vi.hoisted(async () => {
  const { startSiteverify } = await import('./captcha-stand-in.js');
  const stand = await startSiteverify();
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-captcha-${process.pid}-${Date.now()}`,
    CAPTCHA_MODE: 'always',
    CAPTCHA_ON_ERROR: 'allow',
  });
  return stand;
});

/** An address of its own (trusted proxy: X-Forwarded-For), so limits don't add up across tests. */
const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('bot protection, always (e2e)', () => {
  let app: NestNodeApplication;
  let recorded: ReturnType<typeof recordMetrics>;

  beforeAll(async () => {
    recorded = recordMetrics();
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
    await recorded.stop();
  });

  const post = (
    url: string,
    {
      address = ip(),
      token,
      body = {},
    }: { address?: string; token?: string; body?: object } = {},
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'x-forwarded-for': address,
        ...(token && { 'x-captcha-token': token }),
      },
      payload: { email: `${randomUUID().slice(0, 8)}@example.com`, ...body },
    });
  const signIn = (token?: string, address?: string) =>
    post('/v1/probe/sign-in', { token, address, body: { password: 'right' } });

  it('tells the page the provider, the site key and the mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/captcha' });
    expect(res.json()).toEqual({
      captcha: {
        provider: 'turnstile',
        siteKey: siteverify.siteKey,
        mode: 'always',
      },
    });
  });

  it('refuses a request without a token: 403 captcha_required naming the widget', async () => {
    const res = await signIn();
    expect(res.statusCode).toBe(403);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({
      code: 'captcha_required',
      provider: 'turnstile',
      siteKey: siteverify.siteKey,
      action: 'sign-in',
      detail: 'Confirm you are not a robot: solve the challenge and try again.',
    });
    expect(res.body).not.toContain(siteverify.secretKey);
    expect(siteverify.requests).toHaveLength(0);
  });

  it('verifies the token server-side (secret, token, address) and lets the request through', async () => {
    const address = ip();
    expect((await signIn(siteverify.token(), address)).statusCode).toBe(200);
    expect(siteverify.requests).toHaveLength(1);
    expect(siteverify.requests[0]).toMatchObject({
      url: '/siteverify',
      secret: siteverify.secretKey,
      remoteip: address,
    });
    // A valid token doesn't make a wrong password right.
    const wrong = await post('/v1/probe/sign-in', {
      token: siteverify.token(),
      body: { password: 'wrong' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('refuses an invalid token, one the provider saw before, another action and another host', async () => {
    const reasons: [string, string][] = [];
    for (const token of [
      `bad:${randomUUID()}`,
      `spent:${randomUUID()}`,
      siteverify.token('sign-up'),
    ]) {
      const res = await signIn(token);
      expect(res.statusCode).toBe(403);
      reasons.push([res.json().code, res.json().reason]);
    }
    siteverify.state.hostname = 'evil.example';
    const host = await signIn(siteverify.token());
    reasons.push([host.json().code, host.json().reason]);
    expect(reasons).toEqual([
      ['captcha_invalid', 'invalid'],
      ['captcha_invalid', 'duplicate'],
      ['captcha_invalid', 'action'],
      ['captcha_invalid', 'hostname'],
    ]);
  });

  it('spends a token once: a replay is refused without asking the provider again', async () => {
    const token = siteverify.token();
    expect((await signIn(token)).statusCode).toBe(200);
    const replay = await signIn(token);
    expect(replay.json()).toMatchObject({
      code: 'captcha_invalid',
      reason: 'duplicate',
    });
    expect(siteverify.requests).toHaveLength(1);
  });

  it('counts its outcomes in captcha_verifications', async () => {
    await signIn(siteverify.token());
    const counts = await recorded.read('captcha_verifications');
    const passed = counts.find((p) => p.attributes.outcome === 'passed');
    expect(passed!.value).toBeGreaterThan(0);
  });

  it('fail-open: lets a request through unverified when the provider is down, up to CAPTCHA_DEGRADED_LIMIT, then 429', async () => {
    siteverify.state.down = true;
    const address = ip();
    const email = `${randomUUID().slice(0, 8)}@example.com`;
    const attempt = (token: string) =>
      post('/v1/probe/forgot', { address, token, body: { email } });
    expect((await attempt(siteverify.token())).statusCode).toBe(202);
    expect((await attempt(siteverify.token())).statusCode).toBe(202);
    const limited = await attempt(siteverify.token());
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('rate_limited');
  });

  it('does not spend a token it could not judge', async () => {
    siteverify.state.down = true;
    const token = siteverify.token('forgot-password');
    expect((await post('/v1/probe/forgot', { token })).statusCode).toBe(202);
    siteverify.state.down = false;
    expect((await post('/v1/probe/forgot', { token })).statusCode).toBe(202);
  });
});
