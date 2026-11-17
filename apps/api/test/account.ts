import { createHmac } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { AuthenticationOptionsPart } from '../src/iam/auth/authentication-options.js';

/** Cheap hashes for the tests (scrypt's default costs seconds here). */
@Injectable()
@AuthenticationOptionsPart(() => ({ password: { logN: 10 } }))
class CheapPasswords {}

@Module({ providers: [CheapPasswords] })
export class CheapPasswordsModule {}

type Headers = Record<string, string>;
/** What app.inject() answers. */
type Injected = Awaited<ReturnType<NestNodeApplication['inject']>>;

/** Named, so the helper's type doesn't spell out the injection library's path. */
export interface Browser {
  get(url: string, headers?: Headers): Promise<Injected>;
  post(url: string, payload?: object, headers?: Headers): Promise<Injected>;
  patch(url: string, payload: object): Promise<Injected>;
  delete(url: string): Promise<Injected>;
}

/** A browser: an agent keeping its cookies, as `app.inject()` keeps none. */
export function browser(
  app: NestNodeApplication,
  /** The address it calls from (per-address limits). */
  remoteAddress = '127.0.0.1',
): Browser {
  const cookies = new Map<string, string>();
  const send = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Headers = {},
  ): Promise<Injected> => {
    const response = await app.inject({
      method,
      url,
      payload,
      remoteAddress,
      headers: {
        ...headers,
        ...(cookies.size > 0 && {
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        }),
      },
    });
    const set = response.headers['set-cookie'];
    for (const line of Array.isArray(set) ? set : set ? [set] : []) {
      const [pair, ...attributes] = line.split(';');
      const at = pair!.indexOf('=');
      const name = pair!.slice(0, at).trim();
      const value = pair!.slice(at + 1);
      const expired = attributes.some((a) => /max-age=0\b/i.test(a.trim()));
      if (expired || value === '') cookies.delete(name);
      else cookies.set(name, value);
    }
    return response;
  };
  return {
    get: (url: string, headers?: Headers) =>
      send('GET', url, undefined, headers),
    post: (url: string, payload?: object, headers?: Headers) =>
      send('POST', url, payload ?? {}, headers),
    patch: (url: string, payload: object) => send('PATCH', url, payload),
    delete: (url: string) => send('DELETE', url),
  };
}

/** The current code of a base32 TOTP secret (RFC 6238, SHA-1, 6 digits). */
export function totp(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
