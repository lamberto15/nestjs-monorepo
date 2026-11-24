import { AsyncLocalStorage } from 'node:async_hooks';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PasswordHasher } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { BulkheadFullError, BulkheadPolicy } from '@nestjs/resilience';
import type { Counter } from '@opentelemetry/api';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { accountConfig } from './account.config.js';

/** The bulkhead's name (its events and errors). */
export const PASSWORD_HASHING = 'password-hashing';

type Derive = (...args: unknown[]) => Promise<Buffer>;

/**
 * How many password hashes this process runs at once. scrypt is
 * memory-hard: each hash allocates 128·N·r bytes (128 MiB with the default
 * parameters) outside the V8 heap, on the libuv threadpool, which runs four
 * at once (UV_THREADPOOL_SIZE). A burst of sign-ins took four of those, 512
 * MiB on top of the heap, and the container's memory limit killed the
 * replica. So at most `concurrency` hashes run (2: 256 MiB), the next ones
 * wait in order, and past `maxQueue` waiting or `queueTimeoutMs` of waiting
 * they're refused: 503 `server_busy` with Retry-After, never an unbounded
 * pile of requests.
 *
 * @nestjs/resilience's BulkheadPolicy is the limiter (slots, a FIFO queue,
 * its bound and timeout); used inside a service, not as a route decorator,
 * since every route that checks or sets a password shares the one budget.
 */
@Injectable()
export class PasswordHashLimiter implements OnModuleInit {
  readonly bulkhead: BulkheadPolicy;
  /**
   * The most hashes that ever ran at once in this process: the e2e test
   * checks it against the limit.
   */
  peak = 0;
  private readonly rejected?: Counter;
  /** Set inside `run()`: this async context holds a slot already. */
  private readonly holding = new AsyncLocalStorage<true>();

  constructor(
    @Inject(accountConfig.KEY)
    config: Pick<ConfigType<typeof accountConfig>, 'hashing'>,
    private readonly moduleRef: ModuleRef,
    @Optional() metrics?: MetricsService,
  ) {
    const limits = config.hashing;
    this.bulkhead = new BulkheadPolicy({
      name: PASSWORD_HASHING,
      maxConcurrent: limits.concurrency,
      maxQueue: limits.maxQueue,
      queueTimeout: limits.queueTimeoutMs,
    });
    if (metrics) {
      metrics.collect(
        'password_hashes_in_flight',
        'Password hashes (scrypt) running in this process; at most PASSWORD_HASH_CONCURRENCY.',
        () => [{ value: this.bulkhead.active }],
      );
      metrics.collect(
        'password_hashes_queued',
        'Password hashes waiting for a slot in this process.',
        () => [{ value: this.bulkhead.queued }],
      );
      // Both series from the start: the first refusal after a start shows in increase().
      this.rejected = metrics.counter(
        'password_hashes_rejected',
        {
          description:
            'Password hashes refused (503 server_busy): the queue full, or the wait too long.',
        },
        [{ reason: 'full' }, { reason: 'queue-timeout' }],
      );
    }
  }

  /**
   * Puts the package's PasswordHasher (the one instance AuthenticationModule
   * shares with SignInService, PasswordResetService and PasswordSignIn)
   * under the limiter. Custom code: the package has no hook for it.
   *
   * The seam is `derive()`, the package's one expensive step: `hash()`,
   * `verify()` and the dummy hash for unknown users each call it exactly
   * once. The package types it private, hence the cast. Wrapping `hash()`
   * and `verify()` instead would nest: `verify()` calls `hash()` (the
   * dummy), so a call holding a slot would wait for another.
   */
  onModuleInit() {
    const hasher = this.moduleRef.get(PasswordHasher, { strict: false });
    const self = hasher as unknown as { derive: Derive };
    const derive = self.derive;
    if (typeof derive !== 'function') {
      // A new @nestjs/authentication without it: fail at boot, never run unbounded.
      throw new Error(
        'PasswordHasher has no derive(): @nestjs/authentication changed, update iam/account/password-hashing.ts',
      );
    }
    self.derive = (...args) => this.run(() => derive.apply(hasher, args));
  }

  /**
   * Runs `derive` once a slot is free. None free in time, or the queue
   * full: 503 `server_busy` with Retry-After, as `database_busy` (the
   * request was fine, the process is at its hashing budget; clients and
   * load balancers retry, the log has a warning). An HttpException, not the
   * BulkheadFullError, which @nestjs/resilience's interceptor would answer
   * as `BULKHEAD_FULL` without Retry-After.
   *
   * Re-entrant: inside `run()` (in the same async context) a nested `run()`
   * uses the slot already held instead of waiting for another, which would
   * deadlock. So a flow that must not fail after an irreversible step (a
   * reset link consumed before the new password is hashed) reserves the
   * slot first: `limiter.run(() => passwordReset.reset(…))`. The reserved
   * flow derives one hash at a time.
   */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.holding.getStore()) {
      return work();
    }
    try {
      return await this.bulkhead.execute(() => {
        this.peak = Math.max(this.peak, this.bulkhead.active);
        return this.holding.run(true, work);
      });
    } catch (error) {
      if (error instanceof BulkheadFullError) {
        this.rejected?.add(1, { reason: error.reason });
        throw new HttpException(
          {
            message: t('account.serverBusy'),
            code: 'server_busy',
            retryAfter: 1,
          },
          HttpStatus.SERVICE_UNAVAILABLE,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
