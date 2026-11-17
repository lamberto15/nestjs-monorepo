import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomInt,
  sign,
} from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { CompactEncrypt, CompactSign } from 'jose';
import { accessModules } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { appAttestKeys } from './captcha.tables.js';
import { CaptchaModule } from './captcha.module.js';
import { ProbeModule } from './captcha-stand-in.js';

const ANDROID_APP = `com.example.app:${Array.from({ length: 32 }, () => 'AB').join(':')}`;
const APPLE_APP = 'ABCDE12345.com.example.app';

// Read when the app boots: a captcha always asked for, and app attestation on
// for an Android and an iOS app, with Play Integrity keys made for the run
// (the Play Console's, in production).
const keys = vi.hoisted(() => {
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const decryption = crypto.randomBytes(32);
  const signing = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-attestation-${process.pid}-${Date.now()}`,
    NODE_ENV: 'test',
    CAPTCHA_MODE: 'always',
    CAPTCHA_PROVIDER: 'stub',
    APP_ATTESTATION: 'on',
    APP_ATTESTATION_ANDROID_APPS: `com.example.app:${Array.from({ length: 32 }, () => 'AB').join(':')}`,
    APP_ATTESTATION_APPLE_APPS: 'ABCDE12345.com.example.app',
    PLAY_INTEGRITY_DECRYPTION_KEY: decryption.toString('base64'),
    PLAY_INTEGRITY_VERIFICATION_KEY: signing.publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
  });
  return { decryption, signing };
});

const ip = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  parts.forEach((part) => hash.update(part));
  return hash.digest();
};

describe('app attestation in place of the captcha (e2e)', () => {
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

  const challenge = async () =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/auth/app-attestation/challenge',
      })
    ).json().challenge as string;

  /** A guarded request with this proof. */
  const guarded = (attestation?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/probe/forgot',
      headers: {
        'x-forwarded-for': ip(),
        ...(attestation && { 'x-app-attestation': attestation }),
      },
      payload: { email: 'someone@example.com' },
    });

  /** Play Integrity's token for `nonce`, as Play would give the app. */
  async function integrityToken(
    nonce: string,
    device = 'MEETS_DEVICE_INTEGRITY',
  ) {
    const jws = await new CompactSign(
      Buffer.from(
        JSON.stringify({
          requestDetails: {
            requestPackageName: 'com.example.app',
            nonce,
            timestampMillis: String(Date.now()),
          },
          appIntegrity: {
            appRecognitionVerdict: 'PLAY_RECOGNIZED',
            packageName: 'com.example.app',
            certificateSha256Digest: [
              Buffer.from(
                ANDROID_APP.split(':').slice(1).join(''),
                'hex',
              ).toString('base64url'),
            ],
          },
          deviceIntegrity: { deviceRecognitionVerdict: [device] },
        }),
      ),
    )
      .setProtectedHeader({ alg: 'ES256' })
      .sign(keys.signing.privateKey);
    return new CompactEncrypt(Buffer.from(jws))
      .setProtectedHeader({ alg: 'A256KW', enc: 'A256GCM' })
      .encrypt(keys.decryption);
  }

  it('asks for a captcha or a proof, and lets a genuine Android build in, once per challenge', async () => {
    const asked = await guarded();
    expect(asked.statusCode).toBe(403);
    expect(asked.json()).toMatchObject({
      code: 'captcha_required',
      appAttestation: true,
    });
    const nonce = await challenge();
    const proof = `android ${nonce} ${await integrityToken(nonce)}`;
    expect((await guarded(proof)).statusCode).toBe(202);
    // The challenge is spent.
    const replayed = await guarded(proof);
    expect(replayed.statusCode).toBe(403);
    expect(replayed.json()).toMatchObject({
      code: 'attestation_invalid',
      reason: 'challenge',
    });
    const other = await challenge();
    const rooted = await guarded(
      `android ${other} ${await integrityToken(other, 'MEETS_BASIC_INTEGRITY')}`,
    );
    expect(rooted.json().reason).toBe('device');
  });

  it('lets an iOS install in with an assertion by its registered key, counting up', async () => {
    const device = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyId = randomBytes(32).toString('base64url');
    await app
      .get<Database>(getDrizzleToken())
      .insert(appAttestKeys)
      .values({
        keyId,
        appId: APPLE_APP,
        publicKey: device.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64url'),
      });
    const assertion = (nonce: string, count: number) => {
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(count);
      const authenticatorData = Buffer.concat([
        sha256(Buffer.from(APPLE_APP)),
        Buffer.from([0]),
        counter,
      ]);
      const signed = sha256(authenticatorData, sha256(Buffer.from(nonce)));
      return Buffer.from(
        isoCBOR.encode(
          new Map<string, Uint8Array>([
            [
              'signature',
              new Uint8Array(sign('sha256', signed, device.privateKey)),
            ],
            ['authenticatorData', new Uint8Array(authenticatorData)],
          ]),
        ),
      ).toString('base64url');
    };
    const first = await challenge();
    expect(
      (await guarded(`ios ${first} ${keyId} ${assertion(first, 1)}`))
        .statusCode,
    ).toBe(202);
    const second = await challenge();
    const stale = await guarded(
      `ios ${second} ${keyId} ${assertion(second, 1)}`,
    );
    expect(stale.statusCode).toBe(403);
    expect(stale.json().reason).toBe('counter');
    // A registration needs Apple's attestation.
    const refused = await app.inject({
      method: 'POST',
      url: '/v1/auth/app-attestation/keys',
      payload: {
        keyId: 'abc',
        attestation: 'AAAA',
        challenge: await challenge(),
      },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('attestation_invalid');
  });
});
