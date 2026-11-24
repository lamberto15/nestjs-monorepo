import {
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  minutes,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { ScaledThrottlerGuard } from '../../core/throttling/scaled-throttler.guard.js';
import { throttlingConfig } from '../../core/throttling/throttling.config.js';
import { principalKey, type RequestPrincipal } from './principal.js';

/** What `@SkipThrottle()` sets for the default throttler (@nestjs/throttler's THROTTLER_SKIP + name). */
const SKIPPED = 'THROTTLER:SKIPdefault';

export interface UserThrottleOptions {
  /** Requests per `ttl` from one signed-in caller. */
  limit: number;
  /** The window, in milliseconds (`minutes(15)`). */
  ttl: number;
}

const USER_THROTTLE = Symbol('user-throttle');

/**
 * A route's own limit per signed-in caller, in place of the default
 * (RATE_LIMIT_PER_CALLER a minute): for a route that takes no email (the
 * user is known from the credential), so guessing one account's password
 * from many addresses is limited too.
 */
export const UserThrottle = (options: UserThrottleOptions) =>
  SetMetadata(USER_THROTTLE, options);

/**
 * The limit per signed-in user or API client on every route, on top of the
 * global guard's per address (core/throttling), so many callers behind one
 * address don't share one counter and one caller from many addresses
 * doesn't escape it (the nestjs-production skill: per-user limits need the
 * guard after authentication). Global, registered after the principal's
 * guard (AuthModule). Counted per route in the same storage (Redis), under
 * the throttler name `user`; past the limit, 429 `rate_limited` with
 * `Retry-After-user`. `@SkipThrottle()` skips it too.
 *
 * Custom: the throttler's own guard runs before authentication, when the
 * request has no user yet. RATE_LIMIT_MULTIPLIER raises it too
 * (ScaledThrottlerGuard).
 */
@Injectable()
export class UserThrottlerGuard extends ScaledThrottlerGuard {
  private readonly perCaller: number;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    @Inject(throttlingConfig.KEY)
    config: ConfigType<typeof throttlingConfig>,
  ) {
    super(options, storage, reflector, config);
    this.perCaller = config.perCaller;
  }

  override async canActivate(context: ExecutionContext) {
    if (await this.shouldSkip(context)) return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIPPED, targets)) {
      return true;
    }
    const options = this.reflector.getAllAndOverride<
      UserThrottleOptions | undefined
    >(USER_THROTTLE, targets) ?? { limit: this.perCaller, ttl: minutes(1) };
    const { req } = this.getRequestResponse(context);
    const caller = (req as { user?: RequestPrincipal | null }).user;
    if (caller?.kind !== 'user' && caller?.kind !== 'client') {
      return true; // nobody signed in: the address's limit is the one
    }
    return this.handleRequest({
      context,
      limit: options.limit,
      ttl: options.ttl,
      blockDuration: options.ttl,
      throttler: { name: 'user', limit: options.limit, ttl: options.ttl },
      getTracker: async () => principalKey(caller),
      generateKey: (ctx, tracker, name) => this.generateKey(ctx, tracker, name),
    });
  }
}
