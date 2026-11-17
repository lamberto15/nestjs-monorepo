import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import type { NodeRequest as Request } from '@nestjs/platform-node';
import { ApiForbiddenResponse } from '@nestjs/swagger';
import { authConfig } from './auth.config.js';
import { authenticationOf, isRecent } from './authentication-method.js';
import type { Principal, UserPrincipal } from './principal.js';
import { UsersRepository } from './users.repository.js';

export interface RecentAuthenticationOptions {
  /** How recent, in minutes; default REAUTHENTICATION_MAX_AGE_MINUTES (10). */
  maxAgeMinutes?: number;
  /** Only when this holds for the request (e.g. a body field that changes a credential). */
  when?: (request: Request) => boolean;
}

/**
 * How else a user can re-authenticate, besides a password: the module that
 * adds a method (passkeys, magic links, providers) marks a provider with
 * `@ReauthenticationMethods()`; the 403 lists what they all return.
 */
export interface ReauthenticationMethodSource {
  /** Method strings (`passkey`, `oidc:google`) this user can use now. */
  methods(user: UserPrincipal): Promise<string[]>;
}
export const ReauthenticationMethods = DiscoveryService.createDecorator<void>();

const RECENT_AUTHENTICATION = Symbol('recent-authentication');

/**
 * A sensitive route: the user must have signed in (or re-authenticated)
 * within the last `maxAgeMinutes`, else 403 `reauthentication_required`,
 * which lists how they can. Never while impersonating (403). API clients
 * have no sign-in to repeat: not checked.
 *
 * Custom: `@nestjs/authentication` has the second factor's step-up
 * (`@Authenticate({ mfa: true })`) but no authentication age. Runs after the
 * global guards, so a caller without the permission gets that 403 first.
 * Re-authenticating in place (a route that proves the password again and
 * rotates the session) is the account module's; signing in again works.
 */
export const RecentAuthentication = (
  options: RecentAuthenticationOptions = {},
) =>
  applyDecorators(
    SetMetadata(RECENT_AUTHENTICATION, options),
    UseGuards(RecentSignInGuard),
    ApiForbiddenResponse({
      description:
        '`reauthentication_required`: no sign-in in the last REAUTHENTICATION_MAX_AGE_MINUTES: sign in again (the problem lists `methods`) and retry. Or not allowed: your permissions, or acting as another user.',
    }),
  );

/** Whether a request's sign-in is recent enough (`@RecentAuthentication()`). */
@Injectable()
export class RecentAuthenticationCheck {
  constructor(
    private readonly users: UsersRepository,
    private readonly discovery: DiscoveryService,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  /**
   * Nothing, when the request's credential was authenticated within the
   * window; else a 403 `reauthentication_required` that says how to
   * re-authenticate, or a 403 while impersonating. Nobody signed in: 401.
   * An API client: not checked. Anything else: 403.
   */
  async assertRecent(
    user: Principal | null,
    session: unknown,
    maxAgeMinutes = this.config.reauthenticationMaxAgeMinutes,
  ) {
    if (!user) {
      throw new UnauthorizedException();
    }
    if (user.kind === 'client') {
      return;
    }
    if (user.kind !== 'user') {
      throw new ForbiddenException();
    }
    if (user.impersonator) {
      throw new ForbiddenException({
        code: 'not_while_impersonating',
        message: t('auth.notWhileImpersonating'),
      });
    }
    const maxAgeMs = maxAgeMinutes * 60_000;
    const authentication = authenticationOf(session);
    const at = authentication?.authenticatedAt;
    const recentUntil = at ? new Date(at.getTime() + maxAgeMs) : null;
    if (isRecent(authentication, recentUntil)) {
      return;
    }
    throw new ForbiddenException({
      code: 'reauthentication_required',
      message: t('auth.reauthenticationRequired'),
      maxAge: maxAgeMs / 1000,
      authenticatedAt: at?.toISOString() ?? null,
      methods: await this.methods(user),
    });
  }

  private async methods(user: UserPrincipal) {
    const found = await this.users.findActiveByEmail(user.email);
    const sources = this.discovery
      .getProviders({ metadataKey: ReauthenticationMethods.KEY })
      .map((wrapper) => wrapper.instance as ReauthenticationMethodSource)
      .filter(Boolean);
    const others = await Promise.all(
      sources.map((source) => source.methods(user)),
    );
    return [...(found?.passwordHash ? ['password'] : []), ...others.flat()];
  }
}

/**
 * The guard behind `@RecentAuthentication()`. It authenticates nobody: it
 * reads the principal the global PrincipalGuard already set and checks how
 * old its sign-in is (RecentAuthenticationCheck, which AuthModule exports:
 * the guard is built in the module of the route that uses it). Named
 * without "Auth": @nestjs/authorization's startup check goes by class names
 * (/auth(?!or|z)|jwt|api-?key/i), and a guard so named after its own would
 * log a false "@Can() sees every caller as a guest" at every boot.
 */
@Injectable()
export class RecentSignInGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly check: RecentAuthenticationCheck,
  ) {}

  async canActivate(context: ExecutionContext) {
    const options = this.reflector.getAllAndOverride<
      RecentAuthenticationOptions | undefined
    >(RECENT_AUTHENTICATION, [context.getHandler(), context.getClass()]);
    if (!options) {
      return true;
    }
    if (context.getType() !== 'http') {
      return false; // HTTP routes only: fail closed elsewhere
    }
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: Principal | null; session?: unknown }>();
    if (options.when && !options.when(request)) {
      return true;
    }
    await this.check.assertRecent(
      request.user ?? null,
      request.session,
      options.maxAgeMinutes,
    );
    return true;
  }
}
