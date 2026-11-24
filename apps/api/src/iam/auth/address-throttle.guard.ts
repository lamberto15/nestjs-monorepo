import { createHash } from 'node:crypto';
import {
  applyDecorators,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiTooManyRequestsResponse } from '@nestjs/swagger';
import { minutes } from '@nestjs/throttler';
import { ScaledThrottlerGuard } from '../../core/throttling/scaled-throttler.guard.js';
import { normalizeEmail } from './users.repository.js';

export interface AddressThrottleOptions {
  /**
   * The budget's name: every route with the same name draws from one
   * count per address (`passkey`: the options and the answers of the
   * passkey sign-in together). Also the throttler's name in the 429's
   * `Retry-After-<name>` header.
   */
  name: string;
  /** Requests per `ttl` from one address, across the routes of `name`. */
  limit: number;
  /** The window, in milliseconds (`minutes(15)`). */
  ttl: number;
  /**
   * Count per address and the body's `email` (normalized), not per
   * address alone: a password sign-in, where one address may try several
   * accounts and one account must not be guessed at from one address.
   */
  perEmail?: boolean;
  /**
   * With `perEmail`: a second budget per email alone, from every address
   * together, so many addresses can't take turns guessing one account's
   * password. Looser than the address's: past it, that email is refused
   * from everywhere until the window ends (429), its owner included.
   */
  perAccount?: { limit: number; ttl: number };
}

const ADDRESS_THROTTLE = Symbol('address-throttle');

/**
 * A limit per address (or per address and email) shared by a group of
 * routes, on top of the global 600 a minute per address (core/throttling).
 * Counted in the same storage (Redis) under the throttler `name`; past the
 * limit, 429 `rate_limited`. RATE_LIMIT_MULTIPLIER raises it too.
 *
 * Custom: @nestjs/throttler's keys are per route (class and handler in the
 * key), its tracker is the global guard's (the address alone), and a named
 * throttler applies to every route; this guard counts one key per group
 * and caller, on the routes that ask.
 */
export const AddressThrottle = (options: AddressThrottleOptions) =>
  applyDecorators(
    SetMetadata(ADDRESS_THROTTLE, options),
    UseGuards(AddressThrottlerGuard),
    ApiTooManyRequestsResponse({
      description: `rate_limited: more than ${options.limit} requests in ${options.ttl / 60_000} minutes${options.perEmail ? ' for this email' : ''} from this address${options.perAccount ? `, or ${options.perAccount.limit} for this email from every address` : ''}.`,
    }),
  );

/**
 * Every password sign-in (the browser's and a token client's): five tries
 * per email and address every 15 minutes, and twenty per email from every
 * address together, so a password can't be guessed by spreading the tries
 * over many addresses (with CAPTCHA_MODE off, the default, nothing else
 * would stop it).
 */
export const PasswordSignInThrottle = () =>
  AddressThrottle({
    name: 'sign-in',
    limit: 5,
    ttl: minutes(15),
    perEmail: true,
    perAccount: { limit: 20, ttl: minutes(15) },
  });

@Injectable()
export class AddressThrottlerGuard extends ScaledThrottlerGuard {
  override async canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<
      AddressThrottleOptions | undefined
    >(ADDRESS_THROTTLE, [context.getHandler(), context.getClass()]);
    if (!options || context.getType() !== 'http') {
      return true;
    }
    const { req } = this.getRequestResponse(context);
    const email = options.perEmail
      ? emailOf((req as { body?: unknown }).body)
      : '';
    await this.handleRequest({
      context,
      limit: options.limit,
      ttl: options.ttl,
      blockDuration: options.ttl,
      throttler: {
        name: options.name,
        limit: options.limit,
        ttl: options.ttl,
      },
      // The address as the global guard sees it (trusted proxies applied).
      getTracker: (request) => super.getTracker(request),
      generateKey: (_context, tracker, name) =>
        createHash('sha256')
          .update(`address:${name}:${tracker}:${email}`)
          .digest('hex'),
    });
    const account = options.perAccount;
    if (!account || !email) {
      return true;
    }
    const name = `${options.name}-account`;
    return this.handleRequest({
      context,
      limit: account.limit,
      ttl: account.ttl,
      blockDuration: account.ttl,
      throttler: { name, limit: account.limit, ttl: account.ttl },
      getTracker: () => email,
      generateKey: (_context, tracker) =>
        createHash('sha256').update(`account:${name}:${tracker}`).digest('hex'),
    });
  }
}

/** The body's email as the account is found by it, so two spellings share a count. */
function emailOf(body: unknown) {
  const email = (body as { email?: unknown } | null | undefined)?.email;
  return typeof email === 'string' ? normalizeEmail(email) : '';
}
