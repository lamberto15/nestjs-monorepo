import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { type SessionRecord, SessionService } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { roles, userRoles } from '../access/access.tables.js';
import { liveGrant, RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { splitAuthentication } from '../auth/authentication-method.js';
import {
  type Impersonation,
  type ImpersonationEligibility,
  ImpersonationRules,
  impersonationOf,
} from '../auth/impersonation.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { impersonationConfig } from './impersonation.config.js';
import { ImpersonationPolicy } from './impersonation.policy.js';

/**
 * Acting as another member, for support: the administrator's session is
 * replaced by one of the member's that records who is behind it
 * (iam/auth/impersonation.ts; SessionAuth checks it on every request).
 * Every audit entry meanwhile reads `admin@… as user@…`; the session ends
 * after IMPERSONATION_TTL_MINUTES, when IMPERSONATION goes off, or when
 * either membership ends. Stopping gives the administrator a session of
 * their own back, in the tenant it began in.
 *
 * Never across tenants (only a member of the administrator's current
 * tenant, and pinned to it), never as an administrator, never as oneself,
 * never nested, never more than the administrator could grant. An
 * impersonation is never a recent sign-in: sensitive routes refuse it.
 * Who may act as whom (`assertEligible()`) is checked at the start and,
 * as the `@ImpersonationRules()`, by SessionAuth on every request after.
 */
@Injectable()
@ImpersonationRules()
export class ImpersonationService implements ImpersonationEligibility {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly users: UsersRepository,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
    private readonly policy: ImpersonationPolicy,
    @Inject(impersonationConfig.KEY)
    private readonly config: ConfigType<typeof impersonationConfig>,
  ) {}

  /** Starts acting as `targetId`: the new session's Set-Cookie value. */
  async start(
    actor: UserPrincipal,
    session: SessionRecord,
    targetId: string,
    ip?: string,
  ) {
    if (actor.impersonator || impersonationOf(session)) {
      throw new ConflictException({
        code: 'already_impersonating',
        message: t('impersonation.alreadyImpersonating'),
      });
    }
    if (targetId === actor.id) {
      throw new ConflictException({
        code: 'impersonating_yourself',
        message: t('impersonation.yourself'),
      });
    }
    const tenantId = actor.tenantId;
    const target = tenantId
      ? await this.users.inTenant(targetId, tenantId)
      : null;
    if (!target || !tenantId || target.tenantId !== tenantId) {
      throw new NotFoundException(t('impersonation.notFound'));
    }
    await this.assertEligible(actor, target);
    const now = new Date();
    const { rest, authentication } = splitAuthentication(session.metadata);
    const impersonator: Impersonation = {
      id: actor.id,
      email: actor.email,
      mfa: session.mfa ?? null,
      authentication,
      startedAt: now.toISOString(),
      endsAt: new Date(
        now.getTime() + this.config.ttlMinutes * 60_000,
      ).toISOString(),
      tenantId,
    };
    await this.audit.record(actor, {
      action: 'user.impersonation-started',
      targetType: 'user',
      targetId: target.id,
      details: { email: target.email, endsAt: impersonator.endsAt },
      ip,
    });
    await this.sessions.revoke(session.id, { userId: actor.id });
    // The administrator's second factor stands for this session; their
    // sign-in's time doesn't (no authenticatedAt: never a recent one).
    const issued = await this.sessions.create(target.id, {
      mfa: session.mfa,
      metadata: { ...rest, method: 'impersonation', impersonator, tenantId },
    });
    return { cookie: issued.cookie, endsAt: impersonator.endsAt };
  }

  /** Ends the impersonation: the administrator's new session's Set-Cookie value. */
  async stop(user: UserPrincipal, session: SessionRecord, ip?: string) {
    const impersonation = impersonationOf(session);
    if (!impersonation) {
      throw new ConflictException({
        code: 'not_impersonating',
        message: t('impersonation.notImpersonating'),
      });
    }
    await this.sessions.revoke(session.id, { userId: session.userId });
    const {
      impersonator: _,
      method: _method,
      ...metadata
    } = splitAuthentication(session.metadata).rest;
    const issued = await this.sessions.create(impersonation.id, {
      mfa: impersonation.mfa ?? undefined,
      // Back in the tenant it was started in, signed in as before.
      metadata: {
        ...metadata,
        ...impersonation.authentication,
        tenantId: impersonation.tenantId,
      },
    });
    const administrator = await this.users.inTenant(
      impersonation.id,
      impersonation.tenantId,
    );
    if (administrator) {
      await this.audit.record(administrator, {
        action: 'user.impersonation-stopped',
        targetType: 'user',
        targetId: user.id,
        details: { email: user.email },
        ip,
      });
    }
    return { cookie: issued.cookie };
  }

  /**
   * Who may act as whom, in the current tenant (403 with the reason): the
   * actor holds `Access.impersonate` (ImpersonationPolicy, the route's
   * check), the target is no administrator, and the actor holds without
   * conditions everything the target holds. The start checks it, and every
   * request of a running impersonation (mayImpersonate()).
   */
  async assertEligible(actor: UserPrincipal, target: UserPrincipal) {
    if (!(await this.policy.impersonate(actor))) {
      throw new ForbiddenException(t('impersonation.notAllowed'));
    }
    if (await this.isAdministrator(target.id)) {
      throw new ForbiddenException({
        code: 'administrator_not_impersonated',
        message: t('impersonation.administrator'),
      });
    }
    // Acting as someone gives no rights you couldn't grant yourself.
    await this.roles.assertAuthorityOver(actor, target.id, target.email);
  }

  /** assertEligible() as an answer: SessionAuth's check of a running impersonation. */
  async mayImpersonate(actor: UserPrincipal, target: UserPrincipal) {
    try {
      await this.assertEligible(actor, target);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /** Holds the tenant's built-in Administrator role (a grant still running). */
  private async isAdministrator(userId: string) {
    const [row] = await this.db
      .select({ roleId: roles.id })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(
          eq(userRoles.userId, userId),
          eq(roles.system, true),
          liveGrant(userRoles),
        ),
      )
      .limit(1);
    return !!row;
  }
}
