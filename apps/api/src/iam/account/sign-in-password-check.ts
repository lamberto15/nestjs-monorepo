import { createHash } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Redis } from 'ioredis';
import { REDIS } from '../../core/redis/redis.js';
import {
  AUTH_EVENTS,
  type PasswordVerifiedEvent,
} from '../auth/auth.events.js';
import type { UserPrincipal } from '../auth/principal.js';
import { accountConfig } from './account.config.js';
import { AccountWork } from './account-work.js';
import {
  BreachedPasswordsService,
  type HashRange,
  hashRange,
} from './breached-passwords.service.js';
import { SecurityAlerts } from './security-alerts.service.js';

/**
 * The debounce key of one account's current password: its id and a short
 * SHA-256 of the stored scrypt hash. The hash is salted and changes with
 * every new password (and every rehash), so a new password is checked at
 * its first sign-in without anyone clearing anything, and the key says
 * nothing about the password (a digest of a salted, slow hash).
 */
export function recheckKey(userId: string, passwordHash: string) {
  const fingerprint = createHash('sha256')
    .update(passwordHash)
    .digest('base64url')
    .slice(0, 16);
  return `password-breach:${userId}:${fingerprint}`;
}

/** What a check of a sign-in's password came to. */
export type SignInCheckOutcome =
  /** PASSWORD_BREACH_CHECK=off. */
  | 'off'
  /** This password was checked within PASSWORD_BREACH_RECHECK_DAYS. */
  | 'recent'
  /** Not in the breaches (or seen fewer than PASSWORD_BREACH_MIN_COUNT times). */
  | 'clean'
  /** In the breaches: audited, and the owner told. */
  | 'breached'
  /** The API unreachable: nothing recorded, the next sign-in tries again. */
  | 'unknown';

/**
 * Stored passwords against the breach corpus, at sign-in: a password set
 * before it appeared in a breach, or before the check existed, is caught
 * at the next sign-in, and again every PASSWORD_BREACH_RECHECK_DAYS while
 * it stays the same (the corpus grows). Never blocks or slows a sign-in:
 * the check starts once the password is verified and the sign-in goes on
 * without waiting; whatever happens to it is logged, never the sign-in's
 * error. A breached password is audited (`auth.password-breached`) and its
 * owner told (SecurityAlerts: the `passwordBreached` mail and event).
 *
 * Custom code, and not a queue job, on purpose: the range API needs the
 * password's SHA-1, and a job's payload would keep that unsalted hash in
 * Redis (crackable for a weak password) until a worker ran it. Here the
 * plaintext is split at once (`hashRange`) and dropped; the suffix lives
 * only in this process's memory, for one HTTP call.
 */
@Injectable()
export class SignInPasswordCheck implements BeforeApplicationShutdown {
  private readonly logger = new Logger(SignInPasswordCheck.name);
  /** The checks still running (tests, shutdown). */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly breached: BreachedPasswordsService,
    private readonly alerts: SecurityAlerts,
    private readonly work: AccountWork,
    @Inject(accountConfig.KEY)
    private readonly config: Pick<
      ConfigType<typeof accountConfig>,
      'breachCheck'
    >,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @OnEvent(AUTH_EVENTS.passwordVerified)
  passwordVerified(event: PasswordVerifiedEvent) {
    this.start(event.user, event.password, event.passwordHash, event.ip);
  }

  /** Starts the check of a password that was just verified, and returns at once. */
  start(
    user: UserPrincipal,
    password: string,
    passwordHash: string,
    ip: string,
  ) {
    if (!this.breached.enabled) {
      return;
    }
    // The plaintext stops here: only its split SHA-1 goes on.
    const range = hashRange(password);
    const work = this.check(user, range, passwordHash, ip).catch(
      (error: unknown) => {
        this.logger.warn(
          `A sign-in's password was not checked against the breaches: ${
            error instanceof Error ? error.name : 'unknown error'
          }`,
        );
      },
    );
    const tracked = work.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /**
   * The check itself (start() runs it without waiting): skipped when this
   * password was checked within PASSWORD_BREACH_RECHECK_DAYS (one Redis
   * `SET NX EX`, so concurrent sign-ins check it once); a result the API
   * couldn't give releases the key, so the next sign-in tries again.
   */
  async check(
    user: UserPrincipal,
    range: HashRange,
    passwordHash: string,
    ip: string,
  ): Promise<SignInCheckOutcome> {
    if (!this.breached.enabled) {
      return 'off';
    }
    const key = recheckKey(user.id, passwordHash);
    const ttl = this.config.breachCheck.recheckDays * 86_400;
    const claimed = await this.redis.set(key, '1', 'EX', ttl, 'NX');
    if (claimed !== 'OK') {
      return 'recent';
    }
    const breached = await this.breached.isBreachedIn(range);
    if (breached === undefined) {
      await this.redis.del(key);
      return 'unknown';
    }
    if (!breached) {
      return 'clean';
    }
    const alert = await this.work.run(() =>
      this.alerts.credentialsChanged(user, user.id, {
        action: 'auth.password-breached',
        ip,
        alert: 'passwordBreached',
      }),
    );
    await this.alerts.tell(alert);
    return 'breached';
  }

  /** The checks still running, once done (tests, shutdown). */
  async settled() {
    await Promise.allSettled(this.inFlight);
  }

  /** Before Redis and the database close (their onApplicationShutdown). */
  async beforeApplicationShutdown() {
    await this.settled();
  }
}
