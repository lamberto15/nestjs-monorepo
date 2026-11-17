import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { t } from '@nestjs/i18n';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { roles, userRoles } from '../access/access.tables.js';
import { AccessService } from '../access/access.service.js';
import { liveGrant } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';
import { memberships } from '../auth/auth.tables.js';
import { OperatorGuard } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import {
  type BreakGlassGrant,
  breakGlassGrants,
} from './break-glass.tables.js';

/** The longest a grant lasts, and its default: an hour. */
export const BREAK_GLASS_MAX_MINUTES = 60;

/** The request header that names the grant a request reads through. */
export const BREAK_GLASS_HEADER = 'break-glass';

/** Fired after a grant opened: the notifications module tells the tenant's administrators. */
export const BREAK_GLASS_EVENTS = {
  started: 'tenancy.break-glass-started',
} as const;

export interface BreakGlassStartedEvent {
  grantId: string;
  tenantId: string;
  operator: { id: string; email: string };
  reason: string;
  expiresAt: Date;
  /** The tenant's administrators (its built-in role, live, active members). */
  administrators: string[];
  ip?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Break-glass (README.md): an operator reads a tenant that never invited
 * them, in an emergency. Custom: no package offers cross-tenant emergency
 * access; it is built from the tenancy's own doors (Tenancy.run), the
 * audit log and an event.
 *
 * - Who: an active member of the operators' tenant holding
 *   `Platform.breakGlass`, in their own session (never impersonating),
 *   checked when the grant opens and on every request through it.
 * - What: read only (BreakGlassGuard).
 * - How long: at most an hour, never extended; another grant needs a new
 *   reason, and only once this one ended.
 * - Told: the reason is kept with the grant and in both tenants' logs
 *   (`tenant.break-glass-started`, `…-ended`); the tenant's sign-in log
 *   shows it (`method: break-glass`); its administrators are named in
 *   `tenancy.break-glass-started` for the notifications module.
 */
@Injectable()
export class BreakGlassService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly operators: OperatorGuard,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Opens `targetId` to `operator` for `minutes` (at most an hour).
   * The tenant's side first, in a transaction of its own: a failure in
   * between leaves the tenant told of a grant that never opened, never the
   * reverse.
   */
  async start(
    operator: UserPrincipal,
    targetId: string,
    input: { reason: string; minutes?: number },
    ip?: string,
  ) {
    const operatorTenantId = operator.tenantId;
    if (!operatorTenantId || operator.impersonator) {
      throw refused('break_glass_not_allowed', 'breakGlass.notAllowed');
    }
    const target = await this.tenancy.find(targetId);
    if (!target) {
      throw new NotFoundException(t('breakGlass.tenantNotFound'));
    }
    if (target.id === operatorTenantId) {
      throw new ConflictException({
        code: 'break_glass_own_tenant',
        message: t('breakGlass.ownTenant'),
      });
    }
    if (!target.active) {
      throw new ConflictException({
        code: 'tenant_inactive',
        message: t('breakGlass.tenantInactive'),
      });
    }
    const now = new Date();
    const [running] = await this.db
      .select({ id: breakGlassGrants.id })
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.userId, operator.id),
          eq(breakGlassGrants.targetTenantId, target.id),
          isNull(breakGlassGrants.endedAt),
          gt(breakGlassGrants.expiresAt, now),
        ),
      )
      .limit(1);
    if (running) {
      throw new ConflictException({
        code: 'break_glass_active',
        message: t('breakGlass.active'),
      });
    }
    const minutes = Math.min(
      input.minutes ?? BREAK_GLASS_MAX_MINUTES,
      BREAK_GLASS_MAX_MINUTES,
    );
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    const grantId = crypto.randomUUID();
    const details = {
      grantId,
      reason: input.reason,
      expiresAt: expiresAt.toISOString(),
      operatorTenantId,
      tenant: target.slug,
    };

    // The tenant's side: its log, its sign-in log, its administrators.
    const administrators = await this.tenancy.run(target.id, () =>
      this.txHost.withTransaction(async () => {
        await this.audit.record(operator, {
          action: 'tenant.break-glass-started',
          targetType: 'tenant',
          targetId: target.id,
          details,
          ip,
        });
        await this.audit.record(operator, {
          action: SIGN_IN_ACTIONS.succeeded,
          targetType: 'user',
          targetId: operator.id,
          details: { method: 'break-glass', grantId },
          ip,
        });
        return this.administrators(target.id);
      }),
    );

    // The operators' side: the grant, and their own log.
    const grant = await this.txHost.withTransaction(async () => {
      const [row] = await this.db
        .insert(breakGlassGrants)
        .values({
          id: grantId,
          userId: operator.id,
          targetTenantId: target.id,
          reason: input.reason,
          expiresAt,
        })
        .returning();
      await this.audit.record(operator, {
        action: 'tenant.break-glass-started',
        targetType: 'tenant',
        targetId: target.id,
        details,
        ip,
      });
      return row!;
    });
    await this.emitter.emitAsync(BREAK_GLASS_EVENTS.started, {
      grantId,
      tenantId: target.id,
      operator: { id: operator.id, email: operator.email },
      reason: input.reason,
      expiresAt,
      administrators,
      ip,
    } satisfies BreakGlassStartedEvent);
    return view(grant);
  }

  /** The operator's grants to `targetId`, newest first (theirs only). */
  async list(operator: UserPrincipal, targetId: string) {
    const rows = await this.db
      .select()
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.userId, operator.id),
          eq(breakGlassGrants.targetTenantId, targetId),
        ),
      )
      .orderBy(desc(breakGlassGrants.createdAt))
      .limit(50);
    return rows.map(view);
  }

  /**
   * Ends the operator's grant before its time (404 when it isn't theirs, or
   * for another tenant). An ended or expired one stays as it is. Audited
   * `tenant.break-glass-ended` in both tenants.
   */
  async end(
    operator: UserPrincipal,
    targetId: string,
    grantId: string,
    ip?: string,
  ) {
    const now = new Date();
    const outcome = await this.txHost.withTransaction(async () => {
      const [grant] = await this.db
        .select()
        .from(breakGlassGrants)
        .where(
          and(
            eq(breakGlassGrants.id, grantId),
            eq(breakGlassGrants.userId, operator.id),
            eq(breakGlassGrants.targetTenantId, targetId),
          ),
        )
        .for('update');
      if (!grant) {
        throw new NotFoundException(t('breakGlass.grantNotFound'));
      }
      if (grant.endedAt || grant.expiresAt <= now) {
        return { grant, ended: false };
      }
      const [updated] = await this.db
        .update(breakGlassGrants)
        .set({ endedAt: now })
        .where(eq(breakGlassGrants.id, grantId))
        .returning();
      await this.audit.record(operator, endedEntry(updated!, ip));
      return { grant: updated!, ended: true };
    });
    if (outcome.ended) {
      await this.tenancy.run(targetId, () =>
        this.txHost.withTransaction(() =>
          this.audit.record(operator, endedEntry(outcome.grant, ip)),
        ),
      );
    }
    return view(outcome.grant);
  }

  /**
   * The tenant a request through `grantId` reads (BreakGlassGuard),
   * checked again on every request in the operator's own scope: still an
   * operator, still holding `Platform.breakGlass`, their grant neither
   * ended nor expired, the tenant active. 403 otherwise.
   */
  async resolve(user: UserPrincipal, grantId: string) {
    if (user.impersonator || !user.tenantId || !UUID.test(grantId)) {
      throw invalid();
    }
    if (
      !(await this.operators.actsAsOperator(user)) ||
      !(await this.access.can(user, 'breakGlass', 'Platform'))
    ) {
      throw invalid();
    }
    const [grant] = await this.db
      .select()
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.id, grantId),
          eq(breakGlassGrants.userId, user.id),
        ),
      );
    if (!grant || grant.endedAt) {
      throw invalid();
    }
    if (grant.expiresAt.getTime() <= Date.now()) {
      throw refused('break_glass_expired', 'breakGlass.expired');
    }
    const target = await this.tenancy.find(grant.targetTenantId);
    if (!target?.active) {
      throw invalid();
    }
    return { tenantId: target.id, expiresAt: grant.expiresAt };
  }

  /** In the tenant's scope: active members holding its built-in Administrator role, live. */
  private async administrators(tenantId: string) {
    const rows = await this.db
      .selectDistinct({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, userRoles.userId),
          eq(memberships.tenantId, tenantId),
        ),
      )
      .where(
        and(
          eq(roles.system, true),
          eq(memberships.active, true),
          liveGrant(userRoles),
        ),
      );
    return rows.map((row) => row.userId);
  }
}

const refused = (code: string, key: string) =>
  new ForbiddenException({ code, message: t(key) });

const invalid = () => refused('break_glass_invalid', 'breakGlass.invalid');

const endedEntry = (grant: BreakGlassGrant, ip?: string) => ({
  action: 'tenant.break-glass-ended',
  targetType: 'tenant',
  targetId: grant.targetTenantId,
  details: { grantId: grant.id, reason: grant.reason },
  ip,
});

const view = (grant: BreakGlassGrant) => ({
  id: grant.id,
  tenantId: grant.targetTenantId,
  reason: grant.reason,
  createdAt: grant.createdAt,
  expiresAt: grant.expiresAt,
  endedAt: grant.endedAt,
});
