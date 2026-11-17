import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  baseUrl,
  choice,
  flag,
  integer,
  list,
  optional,
  secret,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

/** Cloudflare's siteverify endpoint: CAPTCHA_VERIFY_URL's default. */
export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** The APP_ENV of the load test's stack: the one name that lets a production build run the stub. */
export const LOADTEST_APP_ENV = 'loadtest';

export const schema = z.object({
  /**
   * When a challenge token (`X-Captcha-Token`) is required on the routes that
   * ask for one (sign-in, sign-up, forgot password…): `always`,
   * `after-failures` (once an address or an account had CAPTCHA_FAILURES
   * failed attempts in CAPTCHA_FAILURES_WINDOW_MINUTES), or `off`.
   */
  CAPTCHA_MODE: choice(['off', 'always', 'after-failures'], 'off'),
  /**
   * Who verifies the tokens: Cloudflare `turnstile`, or the `stub` of the
   * tests and load tests (refused in production, except APP_ENV=loadtest).
   */
  CAPTCHA_PROVIDER: choice(['turnstile', 'stub'], 'turnstile'),
  /** Turnstile's site key (public: the widget's, shown by GET /auth/captcha). Required with the mode on. */
  TURNSTILE_SITE_KEY: optional(),
  /** Turnstile's secret key, for the server-side verification. Required with the mode on. */
  TURNSTILE_SECRET_KEY: secret(optional()),
  /** The siteverify endpoint: Cloudflare's, or a stand-in in tests. */
  CAPTCHA_VERIFY_URL: baseUrl(TURNSTILE_VERIFY_URL),
  /**
   * The host names the widget may run on, as the provider reports them
   * (comma-separated, no port). Unset: the hosts of APP_URL and CORS_ORIGINS.
   */
  CAPTCHA_HOSTNAMES: list(),
  /** How long a verification may take (one attempt: the user waits on it). */
  CAPTCHA_TIMEOUT_MS: integer(2000, { min: 100, max: 10_000 }),
  /**
   * When the provider can't be reached (timeout, error, circuit open):
   * `allow` the request under a stricter limit (CAPTCHA_DEGRADED_LIMIT per
   * address in the window: fail-open), or `reject` it with a 503
   * `captcha_unavailable` (fail-closed).
   */
  CAPTCHA_ON_ERROR: choice(['allow', 'reject'], 'allow'),
  /** `after-failures`: failed attempts per address (and per email and address) before a token is required. */
  CAPTCHA_FAILURES: integer(3, { min: 1, max: 100 }),
  /** The window of CAPTCHA_FAILURES, and of CAPTCHA_DEGRADED_LIMIT. */
  CAPTCHA_FAILURES_WINDOW_MINUTES: integer(15, { min: 1, max: 1440 }),
  /** Fail-open: requests let through unverified per address (and per email and address) in the window. */
  CAPTCHA_DEGRADED_LIMIT: integer(2, { min: 1, max: 100 }),
  /**
   * App attestation: where a challenge token is asked for, a genuine build
   * of an app in APP_ATTESTATION_APPLE_APPS (App Attest) or
   * APP_ATTESTATION_ANDROID_APPS (Play Integrity) may send
   * `X-App-Attestation` instead. Off: only the widget's token.
   */
  APP_ATTESTATION: flag('off'),
  /** iOS apps App Attest vouches for: `TEAMID.bundle.identifier`, comma-separated. */
  APP_ATTESTATION_APPLE_APPS: list().refine(
    (apps) => apps.every((app) => /^[A-Z0-9]{10}\.[a-z0-9.-]+$/i.test(app)),
    'comma-separated `TEAMID.bundle.identifier`',
  ),
  /**
   * Android apps Play Integrity vouches for: `package.name:AA:BB:…`
   * (the signing certificate's SHA-256 fingerprint (comma-separated; the fingerprint as `keytool`
   * prints it, 32 colon-separated hex pairs).
   */
  APP_ATTESTATION_ANDROID_APPS: list().refine(
    (apps) =>
      apps.every((app) =>
        /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+:([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(
          app,
        ),
      ),
    'comma-separated `package.name:AA:BB:…` (a SHA-256 certificate fingerprint, 32 colon-separated hex pairs)',
  ),
  /** App Attest's development environment too (debug builds): never in production. */
  APP_ATTEST_DEVELOPMENT: flag('off'),
  /** Play Integrity's response decryption key (Play Console, base64): verdicts are decrypted here, no call to Google. */
  PLAY_INTEGRITY_DECRYPTION_KEY: secret(optional()),
  /** Play Integrity's response verification key (Play Console, base64 SPKI). */
  PLAY_INTEGRITY_VERIFICATION_KEY: optional(),
  NODE_ENV: optional().describe(
    '`production` in a deployment: CAPTCHA_PROVIDER=stub is then refused unless APP_ENV=loadtest.',
  ),
  APP_ENV: optional().describe(
    "The deployment's name (`staging`, `production`, `loadtest`): a name starting with `prod` refuses CAPTCHA_PROVIDER=stub.",
  ),
});

/**
 * Checks the settings that depend on each other, like any other startup
 * check: Turnstile wants both keys once the mode is on, and the stub is never
 * accepted where production might be: NODE_ENV=production (except
 * APP_ENV=loadtest, the load test's stack, which runs the production image to
 * measure the bot check's cost), an APP_ENV that names production, or a
 * Turnstile secret in place (a stub next to a real key is a switch someone
 * forgot).
 */
export function captchaSettings(env: z.output<typeof schema>) {
  if (env.CAPTCHA_PROVIDER === 'stub') {
    const refused =
      env.NODE_ENV === 'production' && env.APP_ENV !== LOADTEST_APP_ENV
        ? `NODE_ENV=production without APP_ENV=${LOADTEST_APP_ENV}`
        : /^prod/i.test(env.APP_ENV ?? '')
          ? `APP_ENV=${env.APP_ENV}`
          : env.TURNSTILE_SECRET_KEY
            ? 'TURNSTILE_SECRET_KEY is set'
            : undefined;
    if (refused) {
      throw new Error(
        `Invalid environment:\nCAPTCHA_PROVIDER=stub is refused (${refused}): use turnstile, or CAPTCHA_MODE=off`,
      );
    }
  } else if (
    env.CAPTCHA_MODE !== 'off' &&
    !(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY)
  ) {
    throw new Error(
      `Invalid environment:\nCAPTCHA_MODE=${env.CAPTCHA_MODE} needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (or TURNSTILE_SECRET_KEY_FILE)`,
    );
  }
  return {
    mode: env.CAPTCHA_MODE,
    provider: env.CAPTCHA_PROVIDER,
    siteKey: env.TURNSTILE_SITE_KEY,
    secretKey: env.TURNSTILE_SECRET_KEY,
    verifyUrl: env.CAPTCHA_VERIFY_URL!,
    hostnames: env.CAPTCHA_HOSTNAMES.map((name) => name.toLowerCase()),
    timeoutMs: env.CAPTCHA_TIMEOUT_MS,
    onError: env.CAPTCHA_ON_ERROR,
    failures: env.CAPTCHA_FAILURES,
    windowMinutes: env.CAPTCHA_FAILURES_WINDOW_MINUTES,
    degradedLimit: env.CAPTCHA_DEGRADED_LIMIT,
    attestation: {
      enabled: env.APP_ATTESTATION,
      appleApps: env.APP_ATTESTATION_APPLE_APPS,
      androidApps: env.APP_ATTESTATION_ANDROID_APPS,
      development: env.APP_ATTEST_DEVELOPMENT,
      playDecryptionKey: env.PLAY_INTEGRITY_DECRYPTION_KEY,
      playVerificationKey: env.PLAY_INTEGRITY_VERIFICATION_KEY,
    },
  };
}

export const captchaConfig = registerAs('captcha', () =>
  captchaSettings(readEnv(schema)),
);

export type CaptchaConfig = ReturnType<typeof captchaSettings>;
