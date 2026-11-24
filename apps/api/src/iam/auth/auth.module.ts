import { randomBytes } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService, type ConfigType } from '@nestjs/config';
import { APP_GUARD, DiscoveryModule, DiscoveryService } from '@nestjs/core';
import {
  AuthenticationModule,
  type AuthenticationModuleOptions,
} from '@nestjs/authentication';
import { ClsService } from 'nestjs-cls';
import { httpConfig } from '../../core/http/http.config.js';
import { SecretsModule } from '../../core/secrets/secrets.module.js';
import { Secrets } from '../../core/secrets/secrets.service.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { throttlingConfig } from '../../core/throttling/throttling.config.js';
import { AddressThrottlerGuard } from './address-throttle.guard.js';
import { ApiKeyAuth } from './api-key-auth.provider.js';
import { authConfig } from './auth.config.js';
import { AuthController } from './auth.controller.js';
import { AuthPolicy } from './auth-policy.js';
import { withOptionParts } from './authentication-options.js';
import { DrizzleAuthenticationStore } from './drizzle-authentication.store.js';
import { JwtAuth } from './jwt-auth.provider.js';
import { MfaEnrollmentGuard } from './mfa-enrollment.guard.js';
import { OnboardingGuard } from './onboarding.guard.js';
import { OperatorGuard } from './operator-only.js';
import { PasswordSignIn } from './password-sign-in.service.js';
import { PrincipalGuard } from './principal.guard.js';
import { RecentAuthenticationCheck } from './recent-authentication.js';
import { ACCESS_TOKEN_TTL_MS, SessionLifetime } from './session-lifetime.js';
import { SessionPruneJob } from './session-prune.job.js';
import { SessionAuth } from './session-auth.provider.js';
import { SignInGates } from './sign-in-gate.js';
import { SignInContext, signInMetadata } from './sign-in-context.js';
import { UsersRepository } from './users.repository.js';
import { WhoAmIController } from './who-am-i.controller.js';
import { UserThrottlerGuard } from './user-throttle.guard.js';
import { WhoAmIParts } from './who-am-i.js';
import './auth-types.js';

/** Exported as they are imported: the decorators' guards, built in other modules, inject them. */
const authFeature = ConfigModule.forFeature(authConfig);
const tenancyFeature = ConfigModule.forFeature(tenancyConfig);
const throttlingFeature = ConfigModule.forFeature(throttlingConfig);

/** The name of the access tokens' signing key in core/secrets, when JWT_SECRET is unset. */
const JWT_KEY_SECRET = 'jwt-signing-key';

/**
 * Who is calling (README.md): @nestjs/authentication with a Drizzle store,
 * three credential providers (session cookie, API key, access token), and
 * the global guards that run after the rate limit, in this order:
 *
 * 1. PrincipalGuard: authenticates (401 unless `@Public()`), refuses the
 *    system principal, enters the principal's tenant.
 * 2. MfaEnrollmentGuard: 403 `mfa_enrollment_required` where a tenant
 *    requires two-factor and the user has none.
 * 3. OnboardingGuard: 403 `onboarding_required` for the first
 *    administrator until the placeholders are replaced.
 *
 * Authorization (@nestjs/authorization's guard, the access module) comes
 * after, so every refusal of who you are precedes one of what you may do.
 * Global: the decorators' guards (`@RecentAuthentication()`,
 * `@OperatorOnly()`, `@UserThrottle()`…) are built in the modules that use
 * them, with what this one exports. Needs EventEmitterModule.forRoot().
 */
@Global()
@Module({
  imports: [
    authFeature,
    tenancyFeature,
    throttlingFeature,
    DiscoveryModule,
    AuthenticationModule.forRootAsync({
      globalGuard: false,
      imports: [
        authFeature,
        ConfigModule.forFeature(httpConfig),
        SecretsModule,
        DiscoveryModule,
      ],
      inject: [
        authConfig.KEY,
        httpConfig.KEY,
        Secrets,
        ClsService,
        DiscoveryService,
        ConfigService,
      ],
      useFactory: async (
        auth: ConfigType<typeof authConfig>,
        http: ConfigType<typeof httpConfig>,
        secrets: Secrets,
        cls: ClsService,
        discovery: DiscoveryService,
        config: ConfigService,
      ): Promise<AuthenticationModuleOptions> =>
        withOptionParts(
          {
            session: {
              absoluteTtl: `${auth.sessionMaxHours}h`,
              idleTtl: `${auth.sessionIdleMinutes}m`,
              cookie: { secure: auth.sessionCookieSecure },
              trustedOrigins: http.corsOrigins,
              // What "where you're signed in" shows, and how this sign-in
              // went (SignInContext): read inside the package's signIn().
              metadata: (request) => ({
                userAgent: firstHeader(request.headers['user-agent']),
                ip: request.ip,
                ...signInMetadata(cls),
              }),
            },
            accessToken: {
              key:
                auth.jwtSecret ??
                (await secrets.loadOrCreate(JWT_KEY_SECRET, () =>
                  randomBytes(32).toString('base64url'),
                )),
              issuer: http.appUrl,
              audience: http.appUrl,
              ttl: ACCESS_TOKEN_TTL_MS,
            },
          },
          discovery,
          { config },
        ),
    }),
  ],
  controllers: [AuthController, WhoAmIController],
  providers: [
    UsersRepository,
    DrizzleAuthenticationStore,
    AuthPolicy,
    SessionLifetime,
    SignInContext,
    SessionAuth,
    ApiKeyAuth,
    JwtAuth,
    PasswordSignIn,
    SignInGates,
    RecentAuthenticationCheck,
    AddressThrottlerGuard,
    OperatorGuard,
    WhoAmIParts,
    SessionPruneJob,
    PrincipalGuard,
    { provide: APP_GUARD, useExisting: PrincipalGuard },
    // After the principal's: the limit per signed-in caller.
    UserThrottlerGuard,
    { provide: APP_GUARD, useExisting: UserThrottlerGuard },
    MfaEnrollmentGuard,
    { provide: APP_GUARD, useExisting: MfaEnrollmentGuard },
    OnboardingGuard,
    { provide: APP_GUARD, useExisting: OnboardingGuard },
  ],
  exports: [
    authFeature,
    tenancyFeature,
    throttlingFeature,
    UsersRepository,
    DrizzleAuthenticationStore,
    AuthPolicy,
    SessionLifetime,
    SignInContext,
    SessionAuth,
    ApiKeyAuth,
    JwtAuth,
    PasswordSignIn,
    SignInGates,
    RecentAuthenticationCheck,
  ],
})
export class AuthModule {}

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;
