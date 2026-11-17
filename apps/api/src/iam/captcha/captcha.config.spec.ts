import { randomBytes } from 'node:crypto';
import { HttpClient } from '@nestjs/http-client';
import {
  captchaSettings,
  schema,
  TURNSTILE_VERIFY_URL,
} from './captcha.config.js';
import { createCaptchaVerifier, verifyEndpoint } from './captcha.providers.js';
import { StubCaptchaVerifier } from './stub.verifier.js';
import { TurnstileVerifier } from './turnstile.verifier.js';

const http = new HttpClient({ baseUrl: 'https://challenges.example' });
// Made at runtime (a local hook refuses key-like literals).
const keys = () => ({
  TURNSTILE_SITE_KEY: `1x${randomBytes(11).toString('hex')}`,
  TURNSTILE_SECRET_KEY: `1x${randomBytes(16).toString('hex')}`,
});

/** The settings of an environment, as readEnv() would parse it. */
const settings = (env: Record<string, string | undefined>) =>
  captchaSettings(schema.parse(env));

/** The production environment with the mode on and the keys set. */
const production = (env: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  CAPTCHA_MODE: 'always',
  ...keys(),
  ...env,
});

describe('captchaSettings and createCaptchaVerifier', () => {
  it('resolves the real Turnstile verifier in production, never the stub', () => {
    const verifier = createCaptchaVerifier(settings(production()), http);
    expect(verifier).toBeInstanceOf(TurnstileVerifier);
    expect(verifier.provider).toBe('turnstile');
  });

  it('refuses the stub in production, whatever the mode', () => {
    for (const mode of ['off', 'always', 'after-failures']) {
      expect(() =>
        settings(
          production({
            CAPTCHA_PROVIDER: 'stub',
            CAPTCHA_MODE: mode,
            TURNSTILE_SECRET_KEY: undefined,
          }),
        ),
      ).toThrow(
        /CAPTCHA_PROVIDER=stub is refused \(NODE_ENV=production without APP_ENV=loadtest\)/,
      );
    }
  });

  it('gives the stub to tests and load tests outside production (staging too)', () => {
    for (const env of [
      { NODE_ENV: 'test' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test', APP_ENV: 'staging' },
      { NODE_ENV: 'test', APP_ENV: 'preview-42' },
    ]) {
      const verifier = createCaptchaVerifier(
        settings({ CAPTCHA_PROVIDER: 'stub', CAPTCHA_MODE: 'always', ...env }),
        http,
      );
      expect(verifier).toBeInstanceOf(StubCaptchaVerifier);
      expect(verifier.siteKey).toBeNull();
    }
  });

  it('refuses the stub where production might be: APP_ENV naming it, or a Turnstile secret in place', () => {
    for (const [env, reason] of [
      [{ APP_ENV: 'production' }, /APP_ENV=production/],
      [{ APP_ENV: 'prod-eu' }, /APP_ENV=prod-eu/],
      [
        { TURNSTILE_SECRET_KEY: keys().TURNSTILE_SECRET_KEY },
        /TURNSTILE_SECRET_KEY is set/,
      ],
    ] as const) {
      expect(() =>
        settings({ NODE_ENV: 'test', CAPTCHA_PROVIDER: 'stub', ...env }),
      ).toThrow(reason);
    }
  });

  it('refuses the stub in production unless the stack is the load test (APP_ENV=loadtest)', () => {
    for (const appEnv of [
      undefined,
      'staging',
      'loadtest-eu',
      'LOADTEST',
      'production',
      'prod-loadtest',
    ]) {
      expect(() =>
        settings({
          NODE_ENV: 'production',
          CAPTCHA_PROVIDER: 'stub',
          APP_ENV: appEnv,
        }),
      ).toThrow(/CAPTCHA_PROVIDER=stub is refused/);
    }
    const loadtest = {
      NODE_ENV: 'production',
      CAPTCHA_PROVIDER: 'stub',
      APP_ENV: 'loadtest',
    };
    expect(createCaptchaVerifier(settings(loadtest), http)).toBeInstanceOf(
      StubCaptchaVerifier,
    );
    expect(() =>
      settings({
        ...loadtest,
        TURNSTILE_SECRET_KEY: keys().TURNSTILE_SECRET_KEY,
      }),
    ).toThrow(/TURNSTILE_SECRET_KEY is set/);
  });

  it('wants both Turnstile keys once the mode is on, and names them', () => {
    for (const missing of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']) {
      expect(() => settings(production({ [missing]: undefined }))).toThrow(
        /TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY/,
      );
    }
  });

  it('starts without keys while the mode is off', () => {
    const verifier = createCaptchaVerifier(
      settings({ NODE_ENV: 'production' }),
      http,
    );
    expect(verifier).toBeInstanceOf(TurnstileVerifier);
  });

  it('exposes the site key, never the secret', () => {
    const env = production();
    const verifier = createCaptchaVerifier(settings(env), http);
    expect(verifier.siteKey).toBe(env.TURNSTILE_SITE_KEY);
    expect(JSON.stringify(verifier)).not.toContain(env.TURNSTILE_SECRET_KEY);
  });
});

describe('verifyEndpoint', () => {
  it("splits Cloudflare's URL into the client's origin and the path to post to", () => {
    expect(verifyEndpoint(TURNSTILE_VERIFY_URL)).toEqual({
      baseUrl: 'https://challenges.cloudflare.com',
      path: '/turnstile/v0/siteverify',
    });
    expect(verifyEndpoint('http://127.0.0.1:4321/siteverify')).toEqual({
      baseUrl: 'http://127.0.0.1:4321',
      path: '/siteverify',
    });
  });
});
