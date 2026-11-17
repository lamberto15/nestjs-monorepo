import type { AccountConfig } from './account.config.js';

/** The relying party: what every ceremony is checked against. */
export interface PasskeySettings {
  enabled: boolean;
  /** The RP ID: the web app's registrable domain. */
  rpId: string;
  rpName: string;
  /** The origins a ceremony's `clientDataJSON.origin` may name. */
  origins: string[];
  challengeTtlSeconds: number;
  androidApps: { packageName: string; fingerprint: string }[];
  appleApps: string[];
}

/** An Android app's FIDO origin: `android:apk-key-hash:` + base64url of its signing certificate's SHA-256 (the fingerprint's bytes). */
export const androidOrigin = (fingerprint: string) =>
  `android:apk-key-hash:${Buffer.from(fingerprint.replace(/:/g, ''), 'hex').toString('base64url')}`;

/**
 * The relying party from the configuration: the same in every process.
 * `webUrl` is WEB_URL, else APP_URL.
 */
export function passkeySettings(
  config: Pick<AccountConfig, 'passkeys' | 'serviceName'>,
  webUrl: string,
): PasskeySettings {
  const { passkeys } = config;
  const androidApps = passkeys.androidApps.map((app) => {
    const [packageName, ...fingerprint] = app.split(':');
    return {
      packageName: packageName!,
      fingerprint: fingerprint.join(':').toUpperCase(),
    };
  });
  return {
    enabled: passkeys.enabled,
    rpId: (passkeys.rpId ?? new URL(webUrl).hostname).toLowerCase(),
    rpName: passkeys.rpName ?? config.serviceName,
    origins: [
      ...new Set([
        new URL(webUrl).origin,
        ...passkeys.origins,
        ...androidApps.map((app) => androidOrigin(app.fingerprint)),
      ]),
    ],
    challengeTtlSeconds: passkeys.challengeTtlSeconds,
    androidApps,
    appleApps: passkeys.appleApps,
  };
}

/** An IPv4 address, or an IPv6 one (it has a colon: `cafe` is a host name). */
const IP_ADDRESS = /^(\d{1,3}(\.\d{1,3}){3}|\[?[0-9a-f]*:[0-9a-f:.]*\]?)$/i;

/** Whether `host` is the RP ID or a host under it (`app.example.com` under `example.com`). */
export const underRpId = (host: string, rpId: string) =>
  host === rpId || host.endsWith(`.${rpId}`);

/**
 * What is wrong with the passkey configuration, as `[variable, message]`
 * pairs; empty when it is consistent. Every environment: an origin that
 * isn't a URL, or one whose host isn't under the RP ID (a browser would
 * refuse the ceremony, and every credential made would be useless).
 * Production only: an RP ID of `localhost` or an address, and origins that
 * aren't `https://` (WebAuthn allows plain http for localhost alone). Off
 * (PASSKEYS=off), nothing is checked. Checked at boot (AccountModule's
 * PasskeysService), since the RP ID never changes once a credential exists.
 */
export function passkeyIssues(
  settings: PasskeySettings,
  production: boolean,
): [string, string][] {
  if (!settings.enabled) {
    return [];
  }
  const issues: [string, string][] = [];
  if (
    production &&
    (settings.rpId === 'localhost' || IP_ADDRESS.test(settings.rpId))
  ) {
    issues.push([
      'PASSKEY_RP_ID',
      `"${settings.rpId}" is not a domain: set PASSKEY_RP_ID (or WEB_URL) to the web app's domain`,
    ]);
  }
  for (const origin of settings.origins) {
    if (origin.startsWith('android:apk-key-hash:')) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      issues.push(['PASSKEY_ORIGINS', `"${origin}" is not a URL`]);
      continue;
    }
    if (url.origin !== origin) {
      issues.push([
        'PASSKEY_ORIGINS',
        `"${origin}" is not an origin (scheme://host[:port], no path)`,
      ]);
    }
    if (production && url.protocol !== 'https:') {
      issues.push([
        'PASSKEY_ORIGINS',
        `"${origin}" is not https: passkeys only work on secure origins`,
      ]);
    }
    if (!underRpId(url.hostname.toLowerCase(), settings.rpId)) {
      issues.push([
        'PASSKEY_RP_ID',
        `origin "${origin}" is not under the RP ID "${settings.rpId}": set PASSKEY_RP_ID to a domain every origin shares`,
      ]);
    }
  }
  return issues;
}
