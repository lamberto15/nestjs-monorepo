import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MfaService } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { and, eq, inArray } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { accountConfig } from '../account/account.config.js';
import { AuditService } from '../audit/audit.service.js';
import { authConfig } from '../auth/auth.config.js';
import { AuthPolicySource } from '../auth/auth-policy.js';
import type { UserPrincipal } from '../auth/principal.js';
import { OrganizationService } from '../organization/organization.service.js';
import type {
  AuthPolicyChanges,
  AuthPolicyView,
} from './auth-policy.schemas.js';
import {
  authPolicies,
  authPolicyPlatform,
  authPolicyUnits,
} from './auth-policy.tables.js';

const DEFAULTS: AuthPolicyView = {
  requireMfa: false,
  passwordMinLength: null,
  passwordHistory: null,
  sessionIdleMinutes: null,
  sessionMaxHours: null,
  allowBreakGlass: true,
};

/**
 * The tenants' sign-in policies (README.md): stored here, applied by
 * iam/auth through `@AuthPolicySource()` under the environment's ceiling
 * (AuthPolicy), so a value here can only tighten what the deployment
 * allows. A change that the ceiling would ignore is refused when it is
 * made, so an administrator learns at once.
 */
@AuthPolicySource()
@Injectable()
export class TenantAuthPolicies implements AuthPolicySource {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly audit: AuditService,
    private readonly mfa: MfaService,
    private readonly tenancy: Tenancy,
    private readonly organization: OrganizationService,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
    @Inject(accountConfig.KEY)
    private readonly account: ConfigType<typeof accountConfig>,
  ) {}

  /** The tenant's policy, its defaults where it chose nothing. */
  async get(tenantId: string): Promise<AuthPolicyView> {
    const [row] = await this.db
      .select()
      .from(authPolicies)
      .where(eq(authPolicies.tenantId, tenantId));
    if (!row) {
      return { ...DEFAULTS };
    }
    return {
      requireMfa: row.requireMfa,
      passwordMinLength: row.passwordMinLength,
      passwordHistory: row.passwordHistory,
      sessionIdleMinutes: row.sessionIdleMinutes,
      sessionMaxHours: row.sessionMaxHours,
      allowBreakGlass: row.allowBreakGlass,
    };
  }

  /**
   * Changes the tenant's policy, audited (`auth-policy.updated`) in the
   * same transaction. Refused: two-factor required where AUTH_MFA is off
   * (400 `setting_not_allowed`), or by a caller who has none (409
   * `mfa_enroll_first`: it would lock them out of this page); a session
   * limit over the deployment's (400 `setting_not_allowed`).
   */
  async update(
    user: UserPrincipal,
    tenantId: string,
    changes: AuthPolicyChanges,
    ip?: string,
  ) {
    if (changes.requireMfa === true) {
      await this.assertMayRequireMfa(user, true);
    }
    if (
      changes.sessionIdleMinutes != null &&
      changes.sessionIdleMinutes > this.auth.sessionIdleMinutes
    ) {
      throw notAllowed(
        'sessionIdleMinutes',
        t('auth-policy.overCeiling', {
          args: {
            name: 'SESSION_IDLE_MINUTES',
            max: this.auth.sessionIdleMinutes,
          },
        }),
      );
    }
    if (
      changes.sessionMaxHours != null &&
      changes.sessionMaxHours > this.auth.sessionMaxHours
    ) {
      throw notAllowed(
        'sessionMaxHours',
        t('auth-policy.overCeiling', {
          args: { name: 'SESSION_MAX_HOURS', max: this.auth.sessionMaxHours },
        }),
      );
    }
    return this.txHost.withTransaction(async () => {
      const next = { ...(await this.get(tenantId)), ...changes };
      await this.db
        .insert(authPolicies)
        .values({ tenantId, ...next })
        .onConflictDoUpdate({
          target: authPolicies.tenantId,
          set: { ...next, updatedAt: new Date() },
        });
      await this.audit.record(user, {
        action: 'auth-policy.updated',
        targetType: 'auth-policy',
        targetId: tenantId,
        details: { changes },
        ip,
      });
      return next;
    });
  }

  /**
   * Two-factor may be required only where it can be set up (AUTH_MFA on),
   * and by a writer it would not lock out: one it covers must have it
   * already (409 `mfa_enroll_first`).
   */
  private async assertMayRequireMfa(user: UserPrincipal, covered: boolean) {
    if (!this.account.mfa) {
      throw notAllowed('requireMfa', t('auth-policy.mfaOff'));
    }
    if (covered && !(await this.mfa.isEnrolled(user.id))) {
      throw new ConflictException({
        code: 'mfa_enroll_first',
        message: t('auth-policy.mfaEnrollFirst'),
      });
    }
  }

  /** The unit's own requirement of two-factor (not the tree's above it). */
  async unitPolicy(unitId: string) {
    await this.organization.get(unitId);
    const [row] = await this.db
      .select({ requireMfa: authPolicyUnits.requireMfa })
      .from(authPolicyUnits)
      .where(eq(authPolicyUnits.unitId, unitId));
    return { requireMfa: row?.requireMfa ?? false };
  }

  /**
   * Requires two-factor of a unit's members and the units under it (or
   * stops: `false` removes the row). Audited `auth-policy.unit-updated`.
   */
  async updateUnit(
    user: UserPrincipal,
    unitId: string,
    requireMfa: boolean,
    ip?: string,
  ) {
    await this.organization.get(unitId);
    if (requireMfa) {
      await this.assertMayRequireMfa(user, await this.covers(user.id, unitId));
    }
    return this.txHost.withTransaction(async () => {
      if (requireMfa) {
        await this.db
          .insert(authPolicyUnits)
          .values({ tenantId: this.tenancy.tenantId(), unitId })
          .onConflictDoNothing();
      } else {
        await this.db
          .delete(authPolicyUnits)
          .where(eq(authPolicyUnits.unitId, unitId));
      }
      await this.audit.record(user, {
        action: 'auth-policy.unit-updated',
        targetType: 'organizational-unit',
        targetId: unitId,
        details: { requireMfa },
        ip,
      });
      return { requireMfa };
    });
  }

  /** The operators' requirement for every tenant. */
  async platformPolicy() {
    const [row] = await this.db
      .select({ requireMfa: authPolicyPlatform.requireMfa })
      .from(authPolicyPlatform);
    return { requireMfa: row?.requireMfa ?? false };
  }

  /** Requires two-factor of every member of every tenant; audited `auth-policy.platform-updated`. */
  async updatePlatform(user: UserPrincipal, requireMfa: boolean, ip?: string) {
    if (requireMfa) {
      // Everyone is covered, the writer too.
      await this.assertMayRequireMfa(user, true);
    }
    return this.txHost.withTransaction(async () => {
      await this.db
        .insert(authPolicyPlatform)
        .values({ requireMfa, updatedBy: `user:${user.id}` })
        .onConflictDoUpdate({
          target: authPolicyPlatform.id,
          set: {
            requireMfa,
            updatedBy: `user:${user.id}`,
            updatedAt: new Date(),
          },
        });
      await this.audit.record(user, {
        action: 'auth-policy.platform-updated',
        targetType: 'auth-policy',
        details: { requireMfa },
        ip,
      });
      return { requireMfa };
    });
  }

  /** The unit and the units above the user's: whether the unit's rule reaches them. */
  private async covers(userId: string, unitId: string) {
    const levels = await this.organization.ancestry(
      await this.organization.unitsOf(userId),
    );
    return levels.flat().includes(unitId);
  }

  // AuthPolicySource: what iam/auth applies under the environment's ceiling.

  /**
   * Two-factor is required of a member when the platform, their tenant or
   * a unit of theirs, or one above it, requires it. AUTH_MFA off: nobody
   * can enrol, so nobody is required to.
   */
  async requireMfa(user: UserPrincipal) {
    if (!this.account.mfa || !user.tenantId) return false;
    const [platform] = await this.db
      .select({ requireMfa: authPolicyPlatform.requireMfa })
      .from(authPolicyPlatform);
    if (platform?.requireMfa) return true;
    if ((await this.get(user.tenantId)).requireMfa) return true;
    return this.tenancy.run(user.tenantId, async () => {
      const units = (
        await this.organization.ancestry(
          await this.organization.unitsOf(user.id),
        )
      ).flat();
      if (!units.length) return false;
      const [row] = await this.db
        .select({ unitId: authPolicyUnits.unitId })
        .from(authPolicyUnits)
        .where(
          and(
            inArray(authPolicyUnits.unitId, units),
            eq(authPolicyUnits.requireMfa, true),
          ),
        )
        .limit(1);
      return Boolean(row);
    });
  }

  async passwordMinLength(tenantId: string) {
    return (await this.get(tenantId)).passwordMinLength ?? undefined;
  }

  async passwordHistory(tenantId: string) {
    return (await this.get(tenantId)).passwordHistory ?? undefined;
  }

  async sessionIdleMinutes(tenantId: string) {
    return (await this.get(tenantId)).sessionIdleMinutes ?? undefined;
  }

  async sessionMaxHours(tenantId: string) {
    return (await this.get(tenantId)).sessionMaxHours ?? undefined;
  }

  async allowsBreakGlass(tenantId: string) {
    return (await this.get(tenantId)).allowBreakGlass;
  }
}

const notAllowed = (path: string, message: string) =>
  new BadRequestException({
    code: 'setting_not_allowed',
    message,
    errors: [{ path, message }],
  });
