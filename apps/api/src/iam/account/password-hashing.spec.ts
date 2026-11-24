import { randomBytes } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { PasswordHasher } from '@nestjs/authentication';
import { recordMetrics } from '../../../test/metrics.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { PasswordHashLimiter } from './password-hashing.js';

interface Limits {
  concurrency: number;
  maxQueue: number;
  queueTimeoutMs: number;
}

const limits = (overrides: Partial<Limits> = {}) => ({
  concurrency: 2,
  maxQueue: 10,
  queueTimeoutMs: 1000,
  ...overrides,
});

const limiterOf = (
  hashing: Limits,
  metrics?: MetricsService,
  hasher = new PasswordHasher({ logN: 10 }),
) => {
  const moduleRef = { get: () => hasher } as unknown as ModuleRef;
  return new PasswordHashLimiter({ hashing }, moduleRef, metrics);
};

/** The package's hasher, put under a new limiter as AccountModule does at boot. */
const bounded = (hashing: Limits) => {
  const hasher = new PasswordHasher({ logN: 10 });
  const limiter = limiterOf(hashing, undefined, hasher);
  limiter.onModuleInit();
  return { hasher, limiter };
};

/** A derivation the test finishes by hand. */
function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => (resolve = done));
  return { promise, resolve };
}

const tick = () => new Promise((done) => setImmediate(done));

// Made at runtime (a local hook refuses password-like literals).
const secret = randomBytes(12).toString('base64url');

describe('PasswordHashLimiter', () => {
  it('runs at most `concurrency` at once and the rest in arrival order', async () => {
    const limiter = limiterOf(limits({ concurrency: 2 }));
    const started: number[] = [];
    const pending = Array.from({ length: 5 }, () => deferred());
    const runs = pending.map((step, index) =>
      limiter.run(() => {
        started.push(index);
        return step.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    expect(limiter.bulkhead.active).toBe(2);
    expect(limiter.bulkhead.queued).toBe(3);

    pending[1].resolve('b');
    await tick();
    expect(started).toEqual([0, 1, 2]);
    pending[0].resolve('a');
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    for (const step of pending.slice(2)) {
      step.resolve('x');
      await tick();
    }
    await expect(Promise.all(runs)).resolves.toEqual(['a', 'b', 'x', 'x', 'x']);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.peak).toBe(2);
    expect(limiter.bulkhead.active).toBe(0);
  });

  it('frees the slot when a derivation fails', async () => {
    const limiter = limiterOf(limits({ concurrency: 1 }));
    await expect(
      limiter.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'next')).resolves.toBe('next');
  });

  it('refuses a call past the queue at once', async () => {
    const limiter = limiterOf(limits({ concurrency: 1, maxQueue: 1 }));
    const running = deferred();
    const first = limiter.run(() => running.promise);
    const second = limiter.run(async () => 'queued');
    const refused = limiter.run(async () => 'never');
    await expect(refused).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      response: { code: 'server_busy', retryAfter: 1 },
    });
    running.resolve('first');
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'queued',
    ]);
  });

  it('lets a call that holds a slot hash inside it without waiting for another', async () => {
    const { hasher, limiter } = bounded(
      limits({ concurrency: 1, maxQueue: 0 }),
    );
    // A reserved flow (a reset: the link, then the hash) under the only slot.
    const hash = await limiter.run(async () => {
      await tick();
      return hasher.hash(secret);
    });
    await expect(hasher.verify(secret, hash)).resolves.toBe(true);
    expect(limiter.peak).toBe(1);
    // Outside it, the slot is back to the others.
    expect(limiter.bulkhead.active).toBe(0);
  });

  it('refuses before the reserved work starts, so it never runs half-way', async () => {
    const limiter = limiterOf(limits({ concurrency: 1, maxQueue: 0 }));
    const running = deferred();
    const first = limiter.run(() => running.promise);
    let started = false;
    await expect(
      limiter.run(async () => {
        started = true;
        return 'consumed the link';
      }),
    ).rejects.toMatchObject({ response: { code: 'server_busy' } });
    expect(started).toBe(false);
    running.resolve('done');
    await first;
  });

  describe('metrics', () => {
    let recorded: ReturnType<typeof recordMetrics>;
    beforeEach(() => {
      recorded = recordMetrics();
    });
    afterEach(() => recorded.stop());

    it('exposes both refusal reasons at 0 from the start', async () => {
      limiterOf(limits(), new MetricsService());
      expect(await recorded.read('password_hashes_rejected')).toEqual([
        { attributes: { reason: 'full' }, value: 0 },
        { attributes: { reason: 'queue-timeout' }, value: 0 },
      ]);
    });

    it('refuses a call that waited `queueTimeoutMs`, and counts it', async () => {
      const metrics = new MetricsService();
      const limiter = limiterOf(
        limits({ concurrency: 1, queueTimeoutMs: 100 }),
        metrics,
      );
      const running = deferred();
      const first = limiter.run(() => running.promise);
      const startedAt = Date.now();
      await expect(limiter.run(async () => 'late')).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
      running.resolve('done');
      await first;
      expect(await recorded.read('password_hashes_rejected')).toContainEqual({
        attributes: { reason: 'queue-timeout' },
        value: 1,
      });
      expect(await recorded.read('password_hashes_in_flight')).toEqual([
        { attributes: {}, value: 0 },
      ]);
      expect(await recorded.read('password_hashes_queued')).toEqual([
        { attributes: {}, value: 0 },
      ]);
    });
  });
});

describe('the bounded PasswordHasher', () => {
  it('runs every scrypt call through the limiter, and keeps the hashes compatible', async () => {
    const { hasher, limiter } = bounded(limits({ concurrency: 1 }));
    const plain = new PasswordHasher({ logN: 10 });

    const hashes = await Promise.all(
      Array.from({ length: 4 }, () => hasher.hash(secret)),
    );
    expect(limiter.peak).toBe(1);
    // The same format and parameters: hashes stored before still verify, and the other way round.
    await expect(plain.verify(secret, hashes[0])).resolves.toBe(true);
    await expect(hasher.verify(secret, await plain.hash(secret))).resolves.toBe(
      true,
    );
    await expect(hasher.verify(`${secret}x`, hashes[0])).resolves.toBe(false);
    // An unknown user (the dummy hash) and an unparseable hash: no slot held while waiting for another.
    await expect(
      Promise.all([
        hasher.verify(secret, undefined),
        hasher.verify(secret, undefined),
        hasher.verify(secret, '!'),
      ]),
    ).resolves.toEqual([false, false, false]);
    expect(limiter.peak).toBe(1);
  });
});
