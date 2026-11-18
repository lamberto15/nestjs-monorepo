import {
  BadRequestException,
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { MfaService } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import {
  authConfig,
  SESSION_IDLE_MINUTES_LIMIT,
  SESSION_MAX_HOURS_LIMIT,
} from './auth.config.js';
import { discoverOne } from './discover.js';
import type { RequestPrincipal, UserPrincipal } from './principal.js';
import { UsersRepository } from './users.repository.js';

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
  /** The tenant's minimum length of a new password, if it chose one. */
  passwordMinLength?(tenantId: string): Promise<number | undefined>;
  /** How many of an account's last passwords the tenant forbids reusing, if it chose. */
  passwordHistory?(tenantId: string): Promise<number | undefined>;
  /**
   * Whether the tenant lets the deployment's operators open it with a
   * break-glass grant; false: it opted out. Absent: allowed.
   */
  allowsBreakGlass?(tenantId: string): Promise<boolean>;
}

/** NIST SP 800-63B: the floor every new password meets, whatever a tenant says. */
export const PASSWORD_MIN_LENGTH = 12;
/** The highest minimum a tenant may ask for: a passphrase, still typeable. */
export const PASSWORD_MIN_LENGTH_LIMIT = 64;
/** The most passwords a tenant may forbid reusing. */
export const PASSWORD_HISTORY_LIMIT = 24;

/**
 * Whose new password is checked: an account (the tenants it belongs to),
 * or the tenants an account is joining (an invitation, a sign-up into the
 * one tenant). A password is the account's, in every tenant: the
 * strictest of them applies.
 */
export type PasswordOwner =
  { userId: string } | { tenantIds: readonly string[] };

/** The strictest of the tenants' choices, between `floor` and `limit`. */
const strictest = (
  chosen: readonly (number | undefined)[],
  floor: number,
  limit: number,
) =>
  Math.min(
    limit,
    Math.max(
      floor,
      ...chosen.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      ),
    ),
  );

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
    private readonly users: UsersRepository,
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
    // Through a break-glass grant: the operator's own tenant's rule, not the one they read.
    const own = principal.breakGlass
      ? { ...principal, tenantId: principal.breakGlass.operatorTenantId }
      : principal;
    if (!(await this.source.requireMfa(own))) {
      return false;
    }
    // Required: enrolled only if two-factor says so. Without its store
    // nobody is, and the requirement holds (fail closed).
    const mfa = this.moduleRef.get(MfaService, { strict: false });
    return !(await mfa.isEnrolled(principal.id));
  }

  /**
   * The minimum length of a new password for its owner: the strictest of
   * its tenants' choices, never under the floor nor over the limit.
   */
  async passwordMinLength(owner: PasswordOwner): Promise<number> {
    const source = this.source?.passwordMinLength?.bind(this.source);
    const chosen = source
      ? await Promise.all((await this.tenantIds(owner)).map(source))
      : [];
    return strictest(chosen, PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH_LIMIT);
  }

  /**
   * How many of the account's last passwords (the current one included) a
   * new one may not repeat, as its tenants chose: the strictest, 0 when
   * none did. The deployment's PASSWORD_HISTORY applies on top (iam/account).
   */
  async passwordHistory(owner: PasswordOwner): Promise<number> {
    const source = this.source?.passwordHistory?.bind(this.source);
    const chosen = source
      ? await Promise.all((await this.tenantIds(owner)).map(source))
      : [];
    return strictest(chosen, 0, PASSWORD_HISTORY_LIMIT);
  }

  /**
   * A 400 `password_too_short` (on the field `path`) when the password is
   * shorter than its owner's tenants ask. The floor and the maximum are
   * the request schema's.
   */
  async assertPasswordLength(
    password: string,
    path: string,
    owner: PasswordOwner,
  ) {
    const min = await this.passwordMinLength(owner);
    // Counted as Zod counts (UTF-16 code units), so both agree.
    if (password.length < min) {
      const message = t('auth.passwordTooShort', { args: { min } });
      throw new BadRequestException({
        code: 'password_too_short',
        message,
        minLength: min,
        errors: [{ path, message }],
      });
    }
  }

  /** Whether the tenant lets the operators in with a break-glass grant (no source: yes). */
  async allowsBreakGlass(tenantId: string): Promise<boolean> {
    return (await this.source?.allowsBreakGlass?.(tenantId)) ?? true;
  }

  private async tenantIds(owner: PasswordOwner) {
    return 'tenantIds' in owner
      ? owner.tenantIds
      : (await this.users.memberships(owner.userId)).map((tenant) => tenant.id);
  }
}
