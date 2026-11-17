import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { MfaService } from '@nestjs/authentication';
import {
  authConfig,
  SESSION_IDLE_MINUTES_LIMIT,
  SESSION_MAX_HOURS_LIMIT,
} from './auth.config.js';
import { discoverOne } from './discover.js';
import type { RequestPrincipal, UserPrincipal } from './principal.js';

/**
 * Auth policies a tenant's administrators change at runtime, with the
 * deployment's environment as the ceiling: what a tenant chooses may only
 * tighten what the environment allows. The module that keeps tenant
 * settings provides the source and marks it `@AuthPolicySource()`; without
 * one, every policy is the environment's alone. Every method is optional.
 */
export interface AuthPolicySource {
  /**
   * Whether the user's current tenant requires two-factor sign-in. The
   * module that provides two-factor answers it (and applies its own
   * deployment switch): a source that requires it with no way to enrol
   * locks the tenant's users out.
   */
  requireMfa?(user: UserPrincipal): Promise<boolean>;
  /** The tenant's idle timeout for sessions, in minutes, if it chose one. */
  sessionIdleMinutes?(tenantId: string): Promise<number | undefined>;
  /** The tenant's absolute session lifetime, in hours, if it chose one. */
  sessionMaxHours?(tenantId: string): Promise<number | undefined>;
}

/** Marks the provider that implements AuthPolicySource (at most one). */
export const AuthPolicySource = DiscoveryService.createDecorator<void>();

/**
 * A session limit under the ceiling: the tenant's choice when it is
 * shorter, else the environment's. A non-number counts as no choice.
 */
export const effectiveSessionLimit = (
  ceiling: number,
  chosen: number | undefined,
) =>
  typeof chosen === 'number' && Number.isFinite(chosen) && chosen > 0
    ? Math.min(ceiling, chosen)
    : ceiling;

/** The policies as they apply: the source's choices under the environment's ceiling. */
@Injectable()
export class AuthPolicy implements OnModuleInit {
  private source?: AuthPolicySource;

  constructor(
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
    private readonly discovery: DiscoveryService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    this.source = discoverOne<AuthPolicySource>(
      this.discovery,
      AuthPolicySource,
      'auth policy source (@AuthPolicySource())',
    );
  }

  /**
   * How long sessions of a tenant last, in milliseconds: the tenant's
   * choices under the environment's ceiling (`idleMs`: without a request;
   * `maxMs`: from the sign-in, however active). No tenant (or no source):
   * the ceiling. `chosen` is what the tenant itself restricted, if it did
   * (a value at the limit is no choice): token families, which have no idle
   * timeout or short lifetime of their own, are limited only by that.
   */
  async sessionLimits(tenantId: string | null | undefined) {
    const idleCeiling = this.config.sessionIdleMinutes;
    const maxCeiling = this.config.sessionMaxHours;
    const source = this.source;
    const [idle, max] =
      tenantId && source
        ? await Promise.all([
            source.sessionIdleMinutes?.(tenantId),
            source.sessionMaxHours?.(tenantId),
          ])
        : [undefined, undefined];
    const idleChosen =
      idle !== undefined && idle < SESSION_IDLE_MINUTES_LIMIT
        ? effectiveSessionLimit(idleCeiling, idle) * 60_000
        : undefined;
    const maxChosen =
      max !== undefined && max < SESSION_MAX_HOURS_LIMIT
        ? effectiveSessionLimit(maxCeiling, max) * 3_600_000
        : undefined;
    return {
      idleMs: idleChosen ?? idleCeiling * 60_000,
      maxMs: maxChosen ?? maxCeiling * 3_600_000,
      chosen: { idleMs: idleChosen, maxMs: maxChosen },
    };
  }

  /**
   * Whether the principal must set up two-factor before anything else: a
   * user (not an API client, not an impersonation: the administrator signed
   * in, not the user) whose current tenant requires it and who has no
   * confirmed authenticator. No source: never.
   */
  async mfaEnrollmentRequired(principal: RequestPrincipal | null | undefined) {
    if (
      principal?.kind !== 'user' ||
      principal.impersonator ||
      !principal.tenantId ||
      !this.source?.requireMfa
    ) {
      return false;
    }
    if (!(await this.source.requireMfa(principal))) {
      return false;
    }
    // Required: enrolled only if two-factor says so. Without its store
    // nobody is, and the requirement holds (fail closed).
    const mfa = this.moduleRef.get(MfaService, { strict: false });
    return !(await mfa.isEnrolled(principal.id));
  }
}
