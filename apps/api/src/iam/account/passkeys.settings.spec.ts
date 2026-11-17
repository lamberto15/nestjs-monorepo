import type { AccountConfig } from './account.config.js';
import {
  androidOrigin,
  passkeyIssues,
  passkeySettings,
} from './passkeys.settings.js';

const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');

interface Env {
  NODE_ENV: 'production' | 'development';
  APP_URL: string;
  WEB_URL?: string;
  PASSKEYS: boolean;
  PASSKEY_RP_ID?: string;
  PASSKEY_ORIGINS: string[];
  PASSKEY_ANDROID_APPS: string[];
}

const env = (overrides: Partial<Env> = {}): Env => ({
  NODE_ENV: 'production',
  APP_URL: 'https://api.example.com',
  WEB_URL: 'https://app.example.com',
  PASSKEYS: true,
  PASSKEY_ORIGINS: [],
  PASSKEY_ANDROID_APPS: [],
  ...overrides,
});

/** The relying party of these variables (WEB_URL, else APP_URL). */
const settingsOf = (e: Env) =>
  passkeySettings(
    {
      serviceName: 'Example',
      passkeys: {
        enabled: e.PASSKEYS,
        rpId: e.PASSKEY_RP_ID,
        rpName: undefined,
        origins: e.PASSKEY_ORIGINS,
        challengeTtlSeconds: 120,
        androidApps: e.PASSKEY_ANDROID_APPS,
        appleApps: [],
      },
    } satisfies Pick<AccountConfig, 'passkeys' | 'serviceName'>,
    e.WEB_URL ?? e.APP_URL,
  );

const issuesOf = (e: Env) =>
  passkeyIssues(settingsOf(e), e.NODE_ENV === 'production');

describe('passkey relying party', () => {
  it("defaults to the web app's host and origin", () => {
    expect(settingsOf(env())).toMatchObject({
      rpId: 'app.example.com',
      rpName: 'Example',
      origins: ['https://app.example.com'],
    });
    expect(settingsOf(env({ WEB_URL: undefined }))).toMatchObject({
      rpId: 'api.example.com',
      origins: ['https://api.example.com'],
    });
    expect(issuesOf(env())).toEqual([]);
  });

  it('takes a parent domain as RP ID, with more origins under it', () => {
    const settings = settingsOf(
      env({
        PASSKEY_RP_ID: 'Example.com',
        PASSKEY_ORIGINS: ['https://admin.example.com'],
      }),
    );
    expect(settings.rpId).toBe('example.com');
    expect(settings.origins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    expect(
      issuesOf(
        env({
          PASSKEY_RP_ID: 'example.com',
          PASSKEY_ORIGINS: ['https://admin.example.com'],
        }),
      ),
    ).toEqual([]);
  });

  it("adds an Android app's origin from its certificate's fingerprint", () => {
    const settings = settingsOf(
      env({
        PASSKEY_ANDROID_APPS: [`com.example.app:${FINGERPRINT.toLowerCase()}`],
      }),
    );
    expect(settings.androidApps).toEqual([
      { packageName: 'com.example.app', fingerprint: FINGERPRINT },
    ]);
    const origin = androidOrigin(FINGERPRINT);
    expect(origin).toBe(
      `android:apk-key-hash:${Buffer.alloc(32, 0xab).toString('base64url')}`,
    );
    expect(settings.origins).toContain(origin);
  });

  it('refuses an origin outside the RP ID, in every environment', () => {
    for (const NODE_ENV of ['production', 'development'] as const) {
      expect(
        issuesOf(
          env({ NODE_ENV, PASSKEY_ORIGINS: ['https://example.org'] }),
        ).map(([variable]) => variable),
      ).toEqual(['PASSKEY_RP_ID']);
      // "evilapp.example.com" is not under "app.example.com".
      expect(
        issuesOf(
          env({ NODE_ENV, PASSKEY_ORIGINS: ['https://evilapp.example.com'] }),
        ),
      ).toHaveLength(1);
    }
  });

  it('refuses origins that are not origins', () => {
    expect(
      issuesOf(env({ PASSKEY_ORIGINS: ['https://app.example.com/login'] })),
    ).toEqual([['PASSKEY_ORIGINS', expect.stringContaining('not an origin')]]);
    expect(issuesOf(env({ PASSKEY_ORIGINS: ['app.example.com'] }))).toEqual([
      ['PASSKEY_ORIGINS', expect.stringContaining('not a URL')],
    ]);
  });

  it('refuses localhost, addresses and plain http in production only', () => {
    const local = env({
      APP_URL: 'http://localhost:3000',
      WEB_URL: 'http://localhost:5173',
    });
    expect(
      issuesOf(local)
        .map(([variable]) => variable)
        .sort(),
    ).toEqual(['PASSKEY_ORIGINS', 'PASSKEY_RP_ID']);
    expect(issuesOf({ ...local, NODE_ENV: 'development' })).toEqual([]);
    expect(
      issuesOf(
        env({ WEB_URL: 'https://10.0.0.5', APP_URL: 'https://10.0.0.5' }),
      ).map(([variable]) => variable),
    ).toEqual(['PASSKEY_RP_ID']);
    expect(
      issuesOf(env({ WEB_URL: 'https://[::1]' })).map(([variable]) => variable),
    ).toContain('PASSKEY_RP_ID');
    // A host name made of hex letters is a host name, not an IPv6 address.
    expect(
      issuesOf(env({ WEB_URL: 'https://cafe', PASSKEY_RP_ID: 'cafe' })),
    ).toEqual([]);
  });

  it('checks nothing when passkeys are off', () => {
    expect(
      issuesOf(
        env({ PASSKEYS: false, PASSKEY_ORIGINS: ['https://example.org'] }),
      ),
    ).toEqual([]);
  });
});
