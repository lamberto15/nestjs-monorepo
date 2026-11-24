import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { type SessionRecord, SessionService } from '@nestjs/authentication';
import { t } from '@nestjs/i18n';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { authConfig } from '../auth/auth.config.js';
import { isOperatorSlug } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { TenantsRepository } from './tenants.repository.js';

/**
 * A user's tenants and the switch between them: one origin, the session
 * carries the tenant it acts in (`metadata.tenantId`), and switching
 * re-issues it there.
 */
@Injectable()
export class TenantSwitchService {
  constructor(
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly users: UsersRepository,
    private readonly repository: TenantsRepository,
    private readonly sessions: SessionService,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
  ) {}

  /**
   * The user's tenants (active memberships of active tenants, the last
   * chosen first), `current` the one they act in. While impersonating,
   * only that one: the person's other tenants are not the administrator's
   * to see.
   */
  async tenantsOf(user: UserPrincipal) {
    const rows = await this.users.memberships(user.id);
    const single =
      this.tenancyMode.mode === 'single'
        ? (await this.tenancy.soleTenant()).id
        : undefined;
    return rows
      .filter((row) => !user.impersonator || row.id === user.tenantId)
      .map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        operator: single
          ? row.id === single
          : isOperatorSlug(this.auth, row.slug),
        current: row.id === user.tenantId,
      }));
  }

  /**
   * Re-issues `session` in `tenantId`, one of the user's active tenants
   * (404 otherwise; 403 while impersonating). The choice (a next sign-in
   * starts there) and its audit entry, in the tenant entered, come first in
   * one transaction; then the rotation, which a concurrent sign-out may
   * have made impossible (null: the caller answers 401). The new session
   * has no `authenticatedAt`: a step-up proven in one tenant doesn't count
   * in another.
   */
  async switch(
    user: UserPrincipal,
    session: SessionRecord,
    tenantId: string,
    ip?: string,
  ) {
    if (user.impersonator) {
      throw new ForbiddenException({
        code: 'not_while_impersonating',
        message: t('auth.notWhileImpersonating'),
      });
    }
    if (!(await this.users.isMember(user.id, tenantId))) {
      throw new NotFoundException({
        code: 'tenant_not_found',
        message: t('tenants.notAMember'),
      });
    }
    await this.tenancy.run(tenantId, () =>
      this.txHost.withTransaction(async () => {
        await this.repository.selectMembership(user.id, tenantId);
        await this.audit.record(
          { ...user, tenantId },
          {
            action: 'auth.tenant-switched',
            targetType: 'tenant',
            targetId: tenantId,
            details: { from: user.tenantId },
            ip,
          },
        );
      }),
    );
    const { authenticatedAt: _stepUp, ...metadata } = session.metadata ?? {};
    const issued = await this.sessions.rotate(session, {
      metadata: { ...metadata, tenantId },
    });
    if (!issued) {
      throw new UnauthorizedException(); // signed out meanwhile
    }
    return issued;
  }
}
