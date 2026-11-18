import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { t } from '@nestjs/i18n';
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  countMatching,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { Events } from '../../core/outbox/events.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { roles, userRoles } from '../access/access.tables.js';
import { ADMINISTRATOR_ROLE, RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { InvitationsService } from '../invitations/invitations.service.js';
import { authConfig } from '../auth/auth.config.js';
import {
  AUTH_EVENTS,
  type SessionEndedEvent,
  type TokenSessionEndedEvent,
} from '../auth/auth.events.js';
import { memberships, refreshTokens, sessions } from '../auth/auth.tables.js';
import { isOperatorSlug } from '../auth/operator-only.js';
import type {
  Principal,
  SystemPrincipal,
  UserPrincipal,
} from '../auth/principal.js';
import {
  distinctTokenSessionIds,
  tokenSessionId,
} from '../auth/token-session.js';
import {
  TENANT_EVENTS,
  type TenantDeactivatedEvent,
  type TenantErasingEvent,
  tenantCreated,
  tenantDeactivated,
  tenantPurged,
  tenantReactivated,
} from './tenants.events.js';
import { tenantList } from './tenants.lists.js';
import { tenantsConfig } from './tenants.config.js';
import { tenantLifecycle } from './tenants.tables.js';

/** What an operator may change of a tenant (`PATCH /v1/tenants/{id}`). */
export interface TenantChanges {
  name?: string;
  slug?: string;
  active?: boolean;
}

/** A tenant as the operators' routes show it. */
export type TenantView = Awaited<ReturnType<TenantsService['get']>>;

/** 409 `tenant_slug_taken`, on the field, so a form shows it under the slug. */
export const slugTaken = (slug: string) =>
  new ConflictException({
    code: 'tenant_slug_taken',
    message: t('tenants.slugTaken', { args: { slug } }),
    errors: [{ path: 'slug', message: t('tenants.slugTakenField') }],
  });

/** 409 `operator_tenant`: the operators' own tenant is never deactivated, deleted nor given another slug. */
const operatorTenant = () =>
  new ConflictException({
    code: 'operator_tenant',
    message: t('tenants.operatorTenant'),
  });

/**
 * The deployment's tenants as its operators run them (README.md): make one
 * with its roles and its first administrator, read them, rename, change a
 * slug, deactivate and reactivate, and delete after a grace period. Every
 * change is audited in the operators' tenant and in the tenant itself (its
 * administrators read what the operators did to it). Sign-up makes tenants
 * through `makeTenant()` too.
 */
@Injectable()
export class TenantsService {
  private readonly list: ReturnType<typeof tenantList>;
  private readonly operator: SQL;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
    private readonly invitations: InvitationsService,
    private readonly emitter: EventEmitter2,
    private readonly events: Events,
    @Inject(tenantsConfig.KEY)
    private readonly config: ConfigType<typeof tenantsConfig>,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
  ) {
    this.operator = this.operatorCondition();
    this.list = tenantList(this.operator);
  }

  /**
   * Which tenant is the operators' (as OperatorGuard decides): with
   * TENANCY=single the oldest (the one), else the one OPERATOR_TENANT names,
   * else none.
   */
  private operatorCondition(): SQL {
    if (this.tenancyMode.mode === 'single') {
      const oldest = this.db
        .select({ id: tenants.id })
        .from(tenants)
        .orderBy(asc(tenants.createdAt), asc(tenants.id))
        .limit(1);
      return inArray(tenants.id, oldest);
    }
    return this.auth.operatorTenant
      ? eq(tenants.slug, this.auth.operatorTenant)
      : sql`false`;
  }

  /**
   * Whether a slug is what makes a tenant the operators' (OPERATOR_TENANT;
   * with TENANCY=single the tenant is the operators' whatever its slug).
   */
  private makesOperator(slug: string) {
    return (
      this.tenancyMode.mode !== 'single' && isOperatorSlug(this.auth, slug)
    );
  }

  private columns() {
    return {
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      active: tenants.active,
      operator: sql<boolean>`(${this.operator})`,
      createdBySignUp: sql<boolean>`coalesce(${tenantLifecycle.createdBySignUp}, false)`,
      deletionRequestedAt: tenantLifecycle.deletionRequestedAt,
      deletionScheduledFor: tenantLifecycle.deletionScheduledFor,
      deletionStartedAt: tenantLifecycle.deletionStartedAt,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    };
  }

  /** A page of the tenants, newest first unless sorted. Global: nothing for row-level security to narrow. */
  async page(query: ListQuery) {
    const joined = () =>
      this.db
        .select({ ...this.columns(), ...this.list.sortSelect(query) })
        .from(tenants)
        .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id));
    const [rows, total] = await Promise.all([
      joined()
        .where(this.list.where(query, tenants.id))
        .orderBy(...pageOrder(tenants.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countMatching(
        this.db,
        this.db
          .select({ one: sql`1` })
          .from(tenants)
          .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
          .where(this.list.where(query)),
        query,
      ),
    ]);
    return toPage(rows, query, total);
  }

  /** One tenant, active or not; a 404 when there is none. */
  async get(id: string) {
    const [tenant] = await this.db
      .select(this.columns())
      .from(tenants)
      .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
      .where(eq(tenants.id, id));
    if (!tenant) {
      throw new NotFoundException(t('tenants.notFound'));
    }
    return tenant;
  }

  /**
   * Renames a tenant, changes its slug, or (de)activates it, under its
   * row's lock (`check`, the caller's If-Match, runs there), audited in
   * both tenants. Deactivated: a session, token, API key or job in it
   * stops (every check reads `tenants.active`); here, after the commit,
   * its sessions and token families end and `tenancy.tenant-deactivated`
   * closes its sockets, so reactivating revives no old session. Nothing
   * else is deleted. The operator tenant is never deactivated nor given
   * another slug (409 `operator_tenant`), and no other tenant takes its slug
   * (409 `tenant_slug_taken`); a tenant is never reactivated while its
   * deletion is pending (409).
   */
  async update(
    operator: UserPrincipal,
    id: string,
    changes: TenantChanges,
    ip?: string,
    check?: (current: TenantView) => void,
  ) {
    const { before, after } = await this.txHost.withTransaction(async () => {
      const before = await this.locked(id);
      check?.(before);
      if (changes.active === false && before.operator) {
        throw operatorTenant();
      }
      // The slug is what makes the operators' tenant theirs: it keeps it,
      // and no other tenant takes it.
      if (changes.slug !== undefined && changes.slug !== before.slug) {
        if (this.makesOperator(before.slug)) {
          throw operatorTenant();
        }
        if (this.makesOperator(changes.slug)) {
          throw slugTaken(changes.slug);
        }
      }
      if (changes.active === true && before.deletionScheduledFor) {
        throw new ConflictException({
          code: 'tenant_deletion_pending',
          message: t('tenants.deletionPending'),
        });
      }
      await this.db
        .update(tenants)
        .set(changes)
        .where(eq(tenants.id, id))
        .catch((error: unknown) => {
          throw databaseErrorKind(error) === 'unique_violation'
            ? slugTaken(changes.slug ?? before.slug)
            : error;
        });
      const after = await this.get(id);
      await this.audit.record(operator, updatedEntry(before, after, ip));
      if (before.active !== after.active) {
        await this.events.publish(
          after.active ? tenantReactivated : tenantDeactivated,
          { tenantId: id },
          { key: id },
        );
      }
      return { before, after };
    });
    await this.inTenantLog(id, operator, updatedEntry(before, after, ip));
    if (before.active && !after.active) {
      await this.afterDeactivation(id);
    }
    return after;
  }

  /**
   * Asks for a tenant's deletion: `slug` typed again (400 otherwise). In
   * one transaction under the row's lock: deactivated, its erase scheduled
   * TENANT_DELETION_GRACE_DAYS later (TenantDeletionJob). Asked again while
   * pending: that one, unchanged. Never the operator tenant (409).
   */
  async requestDeletion(
    operator: UserPrincipal,
    id: string,
    slug: string,
    ip?: string,
  ) {
    const outcome = await this.txHost.withTransaction(async () => {
      const before = await this.locked(id);
      if (before.operator) {
        throw operatorTenant();
      }
      if (before.deletionScheduledFor) {
        return { before, after: before, requested: false };
      }
      if (slug !== before.slug) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: t('tenants.confirmSlug'),
          errors: [{ path: 'slug', message: t('tenants.notThisSlug') }],
        });
      }
      const now = new Date();
      const scheduledFor = new Date(
        now.getTime() + this.config.deletionGraceDays * 86_400_000,
      );
      await this.db
        .update(tenants)
        .set({ active: false })
        .where(eq(tenants.id, id));
      await this.db
        .insert(tenantLifecycle)
        .values({
          tenantId: id,
          deletionRequestedAt: now,
          deletionScheduledFor: scheduledFor,
        })
        .onConflictDoUpdate({
          target: tenantLifecycle.tenantId,
          set: { deletionRequestedAt: now, deletionScheduledFor: scheduledFor },
        });
      const after = await this.get(id);
      await this.audit.record(
        operator,
        deletionEntry('tenant.deletion-requested', after, before, ip),
      );
      if (before.active) {
        await this.events.publish(
          tenantDeactivated,
          { tenantId: id },
          { key: id },
        );
      }
      return { before, after, requested: true };
    });
    if (!outcome.requested) {
      return outcome.after;
    }
    await this.inTenantLog(
      id,
      operator,
      deletionEntry(
        'tenant.deletion-requested',
        outcome.after,
        outcome.before,
        ip,
      ),
    );
    if (outcome.before.active) {
      await this.afterDeactivation(id);
    }
    return outcome.after;
  }

  /**
   * Cancels a pending deletion until the erase starts (409
   * `tenant_deletion_started` from then on; 404 with none pending). The
   * tenant stays deactivated: `PATCH { active: true }` brings it back.
   */
  async cancelDeletion(operator: UserPrincipal, id: string, ip?: string) {
    const { before, after } = await this.txHost.withTransaction(async () => {
      const before = await this.locked(id);
      if (!before.deletionScheduledFor) {
        throw new NotFoundException(t('tenants.noDeletionPending'));
      }
      if (before.deletionStartedAt) {
        throw new ConflictException({
          code: 'tenant_deletion_started',
          message: t('tenants.deletionStarted'),
        });
      }
      await this.db
        .update(tenantLifecycle)
        .set({ deletionRequestedAt: null, deletionScheduledFor: null })
        .where(eq(tenantLifecycle.tenantId, id));
      await this.audit.record(
        operator,
        deletionEntry('tenant.deletion-cancelled', before, before, ip),
      );
      return { before, after: await this.get(id) };
    });
    await this.inTenantLog(
      id,
      operator,
      deletionEntry('tenant.deletion-cancelled', before, before, ip),
    );
    return after;
  }

  /**
   * The operators' way to make a tenant: the tenant, its roles and its
   * first administrator's invitation (InvitationsService, in the tenant's
   * transaction; the mail after the commit), audited in the new tenant and
   * the operators'. Whether the address has an account is never read: the
   * answer is `status: 'invited'` either way.
   */
  async create(
    operator: UserPrincipal,
    input: { name: string; slug: string; administratorEmail: string },
    ip?: string,
  ) {
    const entry = (tenant: Tenant) => ({
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: tenant.id,
      details: { slug: tenant.slug, administrator: input.administratorEmail },
      ip,
    });
    const { tenant, result: invitation } = await this.makeTenant(
      { name: input.name, slug: input.slug },
      async (tenant) => {
        const [administrator] = await this.db
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.key, ADMINISTRATOR_ROLE));
        const invitation = await this.invitations.create(
          { email: input.administratorEmail, roleIds: [administrator!.id] },
          operator,
        );
        await this.audit.record(operator, entry(tenant));
        await this.events.publish(
          tenantCreated,
          { tenantId: tenant.id, slug: tenant.slug, via: 'operator' },
          { key: tenant.id },
        );
        return invitation;
      },
    );
    await this.audit.record(operator, entry(tenant));
    await this.tenancy.run(tenant.id, () =>
      this.invitations.deliver(
        invitation.invitation,
        invitation.token!,
        operator,
      ),
    );
    return {
      ...(await this.get(tenant.id)),
      administrator: {
        email: input.administratorEmail,
        status: 'invited' as const,
        expiresAt: invitation.invitation.expiresAt!,
      },
    };
  }

  /**
   * A new tenant (Tenancy.create(): its row, refused past the one of
   * TENANCY=single), then in its own scope and one transaction its roles
   * (the built-in Administrator and the declared seed roles) and `work`.
   * Two transactions, because a transaction is bound to its tenant when it
   * begins and the tenant's id comes from its insert: when the second fails,
   * the tenant's row is deleted again, so nothing half-made remains. Never
   * with the operators' slug (409 `tenant_slug_taken`), even while no
   * tenant has it: it would make the new tenant's members operators.
   */
  async makeTenant<T>(
    values: { name: string; slug: string },
    work: (tenant: Tenant) => Promise<T>,
    { createdBySignUp = false }: { createdBySignUp?: boolean } = {},
  ): Promise<{ tenant: Tenant; result: T }> {
    // The operators' slug is theirs, even before their tenant exists.
    if (this.makesOperator(values.slug)) {
      throw slugTaken(values.slug);
    }
    const tenant = await this.tenancy.create(values).catch((error: unknown) => {
      throw databaseErrorKind(error) === 'unique_violation'
        ? slugTaken(values.slug)
        : error;
    });
    try {
      const result = await this.tenancy.run(tenant.id, () =>
        this.txHost.withTransaction(async () => {
          await this.roles.seedTenantRoles();
          if (createdBySignUp) {
            await this.db
              .insert(tenantLifecycle)
              .values({ tenantId: tenant.id, createdBySignUp: true });
          }
          return work(tenant);
        }),
      );
      return { tenant, result };
    } catch (error) {
      await this.tenancy.run(null, () =>
        this.db.delete(tenants).where(eq(tenants.id, tenant.id)),
      );
      throw error;
    }
  }

  /**
   * Makes `userId` a member of the current tenant with the Administrator
   * role, in the caller's transaction: a new tenant's first administrator
   * (sign-up). Nothing else grants Administrator without an administrator.
   */
  async addAdministrator(userId: string) {
    await this.db
      .insert(memberships)
      .values({ tenantId: this.tenancy.tenantId(), userId })
      .onConflictDoNothing();
    const [role] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, ADMINISTRATOR_ROLE));
    await this.db.insert(userRoles).values({ userId, roleId: role!.id });
  }

  /**
   * Ends what outlives `tenants.active`: every session and token family
   * acting in the tenant (announced as auth announces its own, for their
   * sockets), then `tenancy.tenant-deactivated` (realtime closes the rest).
   */
  async afterDeactivation(tenantId: string) {
    const ended = await this.db
      .delete(sessions)
      .where(sql`${sessions.metadata} ->> 'tenantId' = ${tenantId}`)
      .returning({ id: sessions.id });
    for (const { id } of ended) {
      await this.emitter.emitAsync(AUTH_EVENTS.sessionEnded, {
        sessionId: id,
      } satisfies SessionEndedEvent);
    }
    const revoked = await this.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(
        and(
          eq(refreshTokens.revoked, false),
          sql`${refreshTokens.claims} ->> 'tid' = ${tenantId}`,
        ),
      )
      .returning({ sid: tokenSessionId });
    for (const sid of distinctTokenSessionIds(revoked)) {
      await this.emitter.emitAsync(AUTH_EVENTS.tokenSessionEnded, {
        sid,
      } satisfies TokenSessionEndedEvent);
    }
    await this.emitter.emitAsync(TENANT_EVENTS.deactivated, {
      tenantId,
    } satisfies TenantDeactivatedEvent);
  }

  /**
   * Deletes a tenant's row, outside any tenant, in one transaction with its
   * `tenant.purged` entry (in no tenant's log: its own goes with it) and
   * event: the database cascades to every tenant table's rows and its
   * memberships. Never the operator tenant (undefined then). `check` runs
   * first in the transaction, under the row's lock; then what lives outside
   * its tables is ended (`tenancy.tenant-erasing`, awaited, in this
   * transaction: a listener's error rolls the erase back), for every erase,
   * the operator's deletion and the sign-up sweep alike.
   */
  async purge(
    system: SystemPrincipal,
    tenantId: string,
    reason: 'deletion' | 'sign-up-unverified',
    details: Record<string, unknown> = {},
    check?: () => Promise<boolean>,
  ) {
    return this.tenancy.run(null, () =>
      this.txHost.withTransaction(async () => {
        const [locked] = await this.db
          .select({ id: tenants.id, operator: this.columns().operator })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .for('update');
        if (!locked || locked.operator || (check && !(await check()))) {
          return undefined;
        }
        await this.emitter.emitAsync(TENANT_EVENTS.erasing, {
          tenantId,
        } satisfies TenantErasingEvent);
        const [row] = await this.db
          .delete(tenants)
          .where(eq(tenants.id, tenantId))
          .returning();
        await this.audit.record(system, {
          action: 'tenant.purged',
          targetType: 'tenant',
          targetId: row!.id,
          details: { slug: row!.slug, name: row!.name, reason, ...details },
        });
        await this.events.publish(
          tenantPurged,
          { tenantId: row!.id, slug: row!.slug, reason },
          { key: row!.id },
        );
        return row;
      }),
    );
  }

  /** The tenant as shown, its row locked for the transaction; a 404 when there is none. */
  private async locked(id: string) {
    const [row] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, id))
      .for('update');
    if (!row) {
      throw new NotFoundException(t('tenants.notFound'));
    }
    return this.get(id);
  }

  /** The tenant's own log too, when the operator acts from another tenant. */
  private async inTenantLog(
    tenantId: string,
    operator: Principal,
    entry: Parameters<AuditService['record']>[1],
  ) {
    if (tenantId !== this.tenancy.current()?.tenantId) {
      await this.tenancy.run(tenantId, () =>
        this.audit.record(operator, entry),
      );
    }
  }
}

/** The audit entry of a tenant's change: what changed, from → to. */
function updatedEntry(before: TenantView, after: TenantView, ip?: string) {
  const changed = (['name', 'slug', 'active'] as const).filter(
    (field) => before[field] !== after[field],
  );
  return {
    action: 'tenant.updated',
    targetType: 'tenant',
    targetId: after.id,
    details: Object.fromEntries(
      changed.map((field) => [
        field,
        { from: before[field], to: after[field] },
      ]),
    ),
    ip,
  };
}

/** The audit entry of a deletion's request or cancel. */
function deletionEntry(
  action: string,
  tenant: TenantView,
  before: TenantView,
  ip?: string,
) {
  return {
    action,
    targetType: 'tenant',
    targetId: tenant.id,
    details: {
      slug: tenant.slug,
      ...(tenant.deletionScheduledFor && {
        scheduledFor: tenant.deletionScheduledFor.toISOString(),
      }),
      ...(action === 'tenant.deletion-requested' && {
        deactivated: before.active,
      }),
    },
    ip,
  };
}
