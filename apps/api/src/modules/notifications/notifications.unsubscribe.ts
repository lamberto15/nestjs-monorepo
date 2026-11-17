import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { httpConfig } from '../../core/http/http.config.js';
import { Secrets } from '../../core/secrets/secrets.service.js';
import type { DigestMode } from './notifications.types.js';

/**
 * How long a link works. A mail is read (and a mail client's unsubscribe
 * button pressed) long after it was sent; a year is the longest a
 * notification mail is still likely to be answered, and turning a mail off
 * is harmless.
 */
const TTL_MS = 365 * 86_400_000;

/** The path of the one-click endpoint, under the API's version prefix. */
export const UNSUBSCRIBE_PATH = '/v1/notifications/unsubscribe';

/**
 * What a valid token names: one user, and what to turn off. `type`: a mail
 * about one notification type; `digests`: a digest mail, which stands for
 * every type the user receives in those modes.
 */
export type UnsubscribeClaims =
  | { userId: string; type: string; digests?: undefined }
  | { userId: string; type?: undefined; digests: DigestMode[] };

const encode = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

/**
 * The tokens of the unsubscribe links in notification mail (RFC 8058): the
 * claims and their expiry, signed with HMAC-SHA256 under a key of their own
 * (made once and kept in the database, core/secrets), so a token can be
 * neither forged nor taken for another kind of token. The link works without
 * a sign-in and repeatedly (switching a mail off twice is no different from
 * once). Custom, because nothing in the NestJS packages signs a link this
 * small and long-lived without a user session.
 */
@Injectable()
export class UnsubscribeLinks {
  private key?: Promise<Buffer>;

  constructor(
    private readonly secrets: Secrets,
    @Inject(httpConfig.KEY)
    private readonly http: Pick<ConfigType<typeof httpConfig>, 'appUrl'>,
  ) {}

  private signingKey() {
    this.key ??= this.secrets
      .loadOrCreate('notification-unsubscribe-key', () =>
        randomBytes(32).toString('base64url'),
      )
      .then((value) => Buffer.from(value));
    return this.key;
  }

  private async sign(claims: Record<string, unknown>, now = Date.now()) {
    const body = encode(JSON.stringify({ ...claims, exp: now + TTL_MS }));
    const mac = createHmac('sha256', await this.signingKey())
      .update(body)
      .digest();
    return `${body}.${encode(mac)}`;
  }

  /** The token for a mail about one notification type. */
  signType(userId: string, type: string) {
    return this.sign({ sub: userId, nt: type });
  }

  /** The token for a digest mail that lists notifications of these modes. */
  signDigests(userId: string, modes: readonly DigestMode[]) {
    return this.sign({ sub: userId, dg: [...new Set(modes)] });
  }

  /** What a token names, or null: badly signed, expired, malformed. */
  async verify(
    token: string,
    now = Date.now(),
  ): Promise<UnsubscribeClaims | null> {
    const [body, mac, extra] = token.split('.');
    if (!body || !mac || extra !== undefined) return null;
    const expected = createHmac('sha256', await this.signingKey())
      .update(body)
      .digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    try {
      const claims = JSON.parse(
        Buffer.from(body, 'base64url').toString('utf8'),
      ) as {
        sub?: unknown;
        nt?: unknown;
        dg?: unknown;
        exp?: unknown;
      };
      if (
        typeof claims.sub !== 'string' ||
        typeof claims.exp !== 'number' ||
        claims.exp < now
      ) {
        return null;
      }
      if (typeof claims.nt === 'string') {
        return { userId: claims.sub, type: claims.nt };
      }
      if (
        Array.isArray(claims.dg) &&
        claims.dg.length > 0 &&
        claims.dg.every((mode) => mode === 'hourly' || mode === 'daily')
      ) {
        return { userId: claims.sub, digests: claims.dg as DigestMode[] };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** The URL a mail client POSTs to (the API's public address). */
  url(token: string) {
    return `${this.http.appUrl}${UNSUBSCRIBE_PATH}/${token}`;
  }

  /** The web app's page for the footer link (the page POSTs the token; a GET must change nothing). */
  pageUrl(token: string) {
    return `${this.http.appUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
  }
}

/**
 * The headers that make a mail one-click unsubscribable (RFC 8058): an https
 * `List-Unsubscribe` URL (plus a `mailto:` where the deployment handles
 * one) and `List-Unsubscribe-Post`. Nothing when the URL is not https: the
 * RFC requires it, and a mail client would ignore the pair.
 */
export function unsubscribeHeaders(
  url: string,
  mailto?: string,
): Record<string, string> {
  if (!url.startsWith('https://')) return {};
  return {
    'List-Unsubscribe': [
      `<${url}>`,
      ...(mailto ? [`<mailto:${mailto}>`] : []),
    ].join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
