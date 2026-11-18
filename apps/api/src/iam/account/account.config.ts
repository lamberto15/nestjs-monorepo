import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  baseUrl,
  flag,
  integer,
  list,
  optional,
  secret,
  withDefault,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';
import { observabilityConfig } from '../../core/observability/observability.config.js';
import { isNativeRedirectUri } from './native-redirect.js';

export const schema = z.object({
  /** Passwordless sign-in by email link (POST /auth/magic-link). Off: its routes answer 404 `feature_off`. */
  AUTH_MAGIC_LINK: flag('on'),
  /**
   * Two-factor sign-in with an authenticator app. Off: setting it up
   * (POST /auth/mfa/enroll, /confirm) answers 404 `feature_off`; accounts
   * that have it keep being asked for a code, and may turn it off.
   */
  AUTH_MFA: flag('on'),
  /** The name authenticator apps show; default SERVICE_NAME. */
  MFA_ISSUER: optional(),
  /**
   * New passwords (reset, invitation, change) are checked against known
   * data breaches (Have I Been Pwned's Pwned Passwords, by k-anonymity:
   * only 5 characters of the password's SHA-1 leave the process).
   */
  PASSWORD_BREACH_CHECK: flag('on'),
  /** The range API's base URL: a self-hosted mirror for air-gapped deployments. */
  PASSWORD_BREACH_API_URL: baseUrl('https://api.pwnedpasswords.com'),
  /** How long a check may take, in milliseconds (one attempt: the user waits on it). */
  PASSWORD_BREACH_TIMEOUT_MS: integer(2000, { min: 100, max: 30_000 }),
  /**
   * When the API can't be reached: `allow` the password unchecked, with a
   * warning in the logs (fail-open), or `reject` it with a 503
   * `password_check_unavailable` (fail-closed).
   */
  PASSWORD_BREACH_ON_ERROR: withDefault('allow').pipe(
    z.enum(['allow', 'reject']),
  ),
  /** Refused when seen in at least this many breaches. */
  PASSWORD_BREACH_MIN_COUNT: integer(1, { min: 1 }),
  /**
   * The password of a sign-in is checked against the breaches too (without
   * delaying it): once per password, then again after this many days (the
   * corpus grows), until the password changes.
   */
  PASSWORD_BREACH_RECHECK_DAYS: integer(30, { min: 1, max: 365 }),
  /**
   * A new password may not repeat the account's last N (the current one
   * counts); 0: off. Only hashes are kept, and only while this is on.
   */
  PASSWORD_HISTORY: integer(0, { min: 0, max: 24 }),
  /**
   * Password hashes (scrypt, 128 MiB each outside the heap) running at once
   * in this process: the container's memory limit must hold the heap plus
   * this many.
   */
  PASSWORD_HASH_CONCURRENCY: integer(2, { min: 1, max: 16 }),
  /** Hashes waiting for a slot; beyond that, 503 `server_busy` at once. */
  PASSWORD_HASH_MAX_QUEUE: integer(20, { min: 0 }),
  /** How long a hash waits for a slot (milliseconds), then 503 `server_busy`. */
  PASSWORD_HASH_QUEUE_TIMEOUT_MS: integer(5000, { min: 100 }),
  /**
   * Where a native app's sign-in through the system browser (a provider, a
   * magic link opened by the app) may end: the app's own scheme or
   * universal / app link (`com.example.app:/auth`,
   * `https://app.example.com/auth/native`), comma-separated, matched
   * exactly. Empty: none.
   */
  NATIVE_REDIRECT_URIS: list().refine(
    (uris) => uris.every(isNativeRedirectUri),
    'comma-separated absolute URIs (a custom scheme, or https), without a fragment',
  ),
  /** Passkeys: registering them, signing in with them (POST /auth/passkeys/…). */
  PASSKEYS: flag('on'),
  /**
   * The relying party id: a registrable domain the web app is served on
   * (`example.com` covers `app.example.com` too), never a port or a
   * scheme. Unset: WEB_URL's host (else APP_URL's). It never changes once
   * passkeys exist: every credential is bound to it.
   */
  PASSKEY_RP_ID: optional().refine(
    (value) => value === undefined || /^[a-z0-9.-]+$/i.test(value),
    'a host name without scheme, port or path',
  ),
  /** The name authenticators show for this service; default SERVICE_NAME. */
  PASSKEY_RP_NAME: optional(),
  /**
   * Origins ceremonies may run on, besides WEB_URL's (comma-separated
   * `https://…` URLs, or `android:apk-key-hash:…`). Each https origin's
   * host must be the RP ID or under it.
   */
  PASSKEY_ORIGINS: list(),
  /** How long a ceremony's challenge lives, in seconds (one-time, in Redis). */
  PASSKEY_CHALLENGE_TTL_SECONDS: integer(120, { min: 30, max: 600 }),
  /**
   * Android apps allowed to use this RP ID's passkeys (served at
   * /.well-known/assetlinks.json): `package.name:SHA256_FINGERPRINT` of
   * the signing certificate (colon-separated hex), comma-separated.
   */
  PASSKEY_ANDROID_APPS: list().refine(
    (apps) =>
      apps.every((app) =>
        /^[a-z][\w.]*:([0-9a-f]{2}:){31}[0-9a-f]{2}$/i.test(app),
      ),
    'comma-separated `package.name:AA:BB:…` (32 bytes of hex)',
  ),
  /**
   * iOS and macOS apps allowed to use this RP ID's passkeys (served at
   * /.well-known/apple-app-site-association): `TEAMID.bundle.identifier`,
   * comma-separated.
   */
  PASSKEY_APPLE_APPS: list().refine(
    (apps) => apps.every((app) => /^[A-Z0-9]{10}\.[a-z0-9.-]+$/i.test(app)),
    'comma-separated `TEAMID.bundle.identifier`',
  ),
  // Sign in with a provider: each one is on when its client id and secret are set.
  // Redirect URI to register: <APP_URL>/v1/auth/oidc/<provider>/callback
  /** Google's OAuth client id. */
  GOOGLE_CLIENT_ID: optional(),
  /** Google's OAuth client secret. */
  GOOGLE_CLIENT_SECRET: secret(optional()),
  /** Microsoft Entra ID: the tenant's id (a GUID), single tenant. */
  MICROSOFT_TENANT_ID: optional(),
  /** Microsoft Entra ID: the application's client id. */
  MICROSOFT_CLIENT_ID: optional(),
  /** Microsoft Entra ID: the application's client secret. */
  MICROSOFT_CLIENT_SECRET: secret(optional()),
  /** GitHub's OAuth app client id. */
  GITHUB_CLIENT_ID: optional(),
  /** GitHub's OAuth app client secret. */
  GITHUB_CLIENT_SECRET: secret(optional()),
  /** Read for the passkey checks: production refuses a localhost RP ID and plain-http origins. */
  NODE_ENV: optional(),
});

export const accountConfig = registerAs('account', () => {
  const env = readEnv(schema);
  // SERVICE_NAME is observability's (core): the default MFA issuer and passkey RP name.
  const { serviceName } = observabilityConfig();
  return {
    magicLink: env.AUTH_MAGIC_LINK,
    mfa: env.AUTH_MFA,
    mfaIssuer: env.MFA_ISSUER ?? serviceName,
    serviceName,
    production: env.NODE_ENV === 'production',
    breachCheck: {
      enabled: env.PASSWORD_BREACH_CHECK,
      apiUrl: env.PASSWORD_BREACH_API_URL!,
      timeoutMs: env.PASSWORD_BREACH_TIMEOUT_MS,
      onError: env.PASSWORD_BREACH_ON_ERROR,
      minCount: env.PASSWORD_BREACH_MIN_COUNT,
      recheckDays: env.PASSWORD_BREACH_RECHECK_DAYS,
    },
    passwordHistory: env.PASSWORD_HISTORY,
    hashing: {
      concurrency: env.PASSWORD_HASH_CONCURRENCY,
      maxQueue: env.PASSWORD_HASH_MAX_QUEUE,
      queueTimeoutMs: env.PASSWORD_HASH_QUEUE_TIMEOUT_MS,
    },
    nativeRedirectUris: env.NATIVE_REDIRECT_URIS,
    passkeys: {
      enabled: env.PASSKEYS,
      rpId: env.PASSKEY_RP_ID,
      rpName: env.PASSKEY_RP_NAME,
      origins: env.PASSKEY_ORIGINS,
      challengeTtlSeconds: env.PASSKEY_CHALLENGE_TTL_SECONDS,
      androidApps: env.PASSKEY_ANDROID_APPS,
      appleApps: env.PASSKEY_APPLE_APPS,
    },
    providers: {
      google: pair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
      microsoft:
        env.MICROSOFT_TENANT_ID &&
        pair(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET)
          ? {
              tenant: env.MICROSOFT_TENANT_ID,
              ...pair(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET)!,
            }
          : undefined,
      github: pair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
    },
  };
});

export type AccountConfig = ReturnType<typeof accountConfig>;

const pair = (clientId?: string, clientSecret?: string) =>
  clientId && clientSecret ? { clientId, clientSecret } : undefined;
