import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { t } from '@nestjs/i18n';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Events } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SIGN_IN_ACTIONS } from '../audit/sign-in-actions.js';
import { AuthPolicy } from '../auth/auth-policy.js';
import {
  BreakGlassGrantSource,
  type BreakGlassGrants,
  type BreakGlassRequest,
} from '../auth/break-glass-session.js';
import { OperatorGuard } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { breakGlassStarted } from './break-glass.events.js';
import { BreakGlassRepository } from './break-glass.repository.js';
import type { BreakGlassGrant } from './break-glass.tables.js';

/** The longest a grant lasts, and its default: an hour. */
export const BREAK_GLASS_MAX_MINUTES = 60;

/** The methods a request through a grant may use: reading only. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

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
 * - What: read only. A request naming a grant (`Break-Glass: <id>`) is
 *   checked here on every request (`open()`, auth's
 *   `@BreakGlassGrantSource()`); auth's PrincipalGuard then runs it in the
 *   tenant read only (core/tenancy: PostgreSQL refuses any write) with the
 *   catalog's read actions alone (iam/access). Each such request is
 *   audited `tenant.break-glass-read` in the tenant and logged.
 * - Opt-out: the tenant's `allowBreakGlass` (iam/auth-policy): false
 *   refuses new grants and stops running ones at their next request.
 * - How long: at most an hour, never extended; another grant needs a new
 *   reason, and only once this one ended.
 * - Told: the reason is kept with the grant and in both tenants' logs
 *   (`tenant.break-glass-started`, `…-ended`); the tenant's sign-in log
 *   shows it (`method: break-glass`); its administrators are named in
 *   the domain event `tenancy.break-glass-started`, published in the
 *   tenant, for the notifications module.
 */
@BreakGlassGrantSource()
@Injectable()
export class BreakGlassService implements BreakGlassGrants {
  private readonly logger = new Logger(BreakGlassService.name);

  constructor(
    private readonly repository: BreakGlassRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly operators: OperatorGuard,
    private readonly authPolicy: AuthPolicy,
    private readonly events: Events,
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
    if (!operatorTenantId || operator.impersonator || operator.breakGlass) {
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
    if (!(await this.authPolicy.allowsBreakGlass(target.id))) {
      throw disabled();
    }
    const now = new Date();
    if (await this.repository.hasRunningGrant(operator.id, target.id, now)) {
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

    // The tenant's side: its log, its sign-in log, its administrators told.
    await this.tenancy.run(target.id, () =>
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
        await this.events.publish(
          breakGlassStarted,
          {
            grantId,
            operator: { id: operator.id, email: operator.email },
            reason: input.reason,
            expiresAt: expiresAt.toISOString(),
            administrators: await this.repository.administratorIds(target.id),
            ...(ip && { ip }),
          },
          { key: grantId },
        );
      }),
    );

    // The operators' side: the grant, and their own log.
    const grant = await this.txHost.withTransaction(async () => {
      const row = await this.repository.insert({
        id: grantId,
        userId: operator.id,
        targetTenantId: target.id,
        reason: input.reason,
        expiresAt,
      });
      await this.audit.record(operator, {
        action: 'tenant.break-glass-started',
        targetType: 'tenant',
        targetId: target.id,
        details,
        ip,
      });
      return row;
    });
    return view(grant);
  }

  /** The operator's grants to `targetId`, newest first (theirs only). */
  async list(operator: UserPrincipal, targetId: string) {
    const rows = await this.repository.listOf(operator.id, targetId);
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
      const grant = await this.repository.lockGrant(
        grantId,
        operator.id,
        targetId,
      );
      if (!grant) {
        throw new NotFoundException(t('breakGlass.grantNotFound'));
      }
      if (grant.endedAt || grant.expiresAt <= now) {
        return { grant, ended: false };
      }
      const updated = await this.repository.end(grantId, now);
      await this.audit.record(operator, endedEntry(updated, ip));
      return { grant: updated, ended: true };
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
   * The tenant a request through `grantId` reads (auth's PrincipalGuard
   * asks, in the operator's own scope), checked on every request: still an
   * operator, still holding `Platform.breakGlass`, their grant neither
   * ended nor expired, the tenant active and not opted out, and the request
   * a read (403 `break_glass_read_only` otherwise). Audited
   * `tenant.break-glass-read` in the tenant, in a transaction of its own
   * before the request turns read only, and logged.
   */
  async open(user: UserPrincipal, grantId: string, request: BreakGlassRequest) {
    const { tenantId, expiresAt } = await this.resolve(user, grantId);
    if (!SAFE.has(request.method.toUpperCase())) {
      throw refused('break_glass_read_only', 'breakGlass.readOnly');
    }
    const through: UserPrincipal = {
      ...user,
      breakGlass: {
        grantId,
        tenantId,
        operatorTenantId: user.tenantId!,
        expiresAt: expiresAt.toISOString(),
      },
    };
    await this.tenancy.run(tenantId, () =>
      this.txHost.withTransaction(() =>
        this.audit.record(through, {
          action: 'tenant.break-glass-read',
          targetType: 'tenant',
          targetId: tenantId,
          details: { grantId, method: request.method, path: request.path },
          ip: request.ip,
        }),
      ),
    );
    this.logger.log(
      `${user.email} reads tenant ${tenantId} (grant ${grantId}): ${request.method} ${request.path}`,
    );
    return { tenantId, expiresAt };
  }

  private async resolve(user: UserPrincipal, grantId: string) {
    if (
      user.impersonator ||
      user.breakGlass ||
      !user.tenantId ||
      !UUID.test(grantId)
    ) {
      throw invalid();
    }
    if (
      !(await this.operators.actsAsOperator(user)) ||
      !(await this.access.can(user, 'breakGlass', 'Platform'))
    ) {
      throw invalid();
    }
    const grant = await this.repository.findOf(grantId, user.id);
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
    if (!(await this.authPolicy.allowsBreakGlass(target.id))) {
      throw disabled();
    }
    return { tenantId: target.id, expiresAt: grant.expiresAt };
  }
}

const refused = (code: string, key: string) =>
  new ForbiddenException({ code, message: t(key) });

const invalid = () => refused('break_glass_invalid', 'breakGlass.invalid');

const disabled = () => refused('break_glass_disabled', 'breakGlass.disabled');

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
