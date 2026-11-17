import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { t } from '@nestjs/i18n';
import { eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { REDIS } from '../../core/redis/redis.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  periodOf,
  type Quota,
  QuotaRegistration,
  type RateQuota,
  type StockQuota,
} from './quota.js';
import type { SetTenantQuotas } from './quotas.schemas.js';
import { quotaPlans, tenantQuotas } from './quotas.tables.js';

/** The plan every tenant without one is on. */
export const DEFAULT_PLAN = 'default';

/** What a check of a rate quota found. */
export interface RateOutcome {
  allowed: boolean;
  /** Used this period, this request included when allowed. */
  used: number;
  limit: number | null;
  resetsAt: Date;
}

/**
 * Limits per tenant, and the check-and-consume API the modules that own a
 * limited thing call (README.md). A tenant's limit for a quota is, in order:
 * the limit the operators set for the tenant, its plan's, the default
 * plan's, the quota's own default, else unlimited.
 */
@Injectable()
export class QuotasService implements OnModuleInit {
  private readonly logger = new Logger('Quotas');
  private readonly known = new Map<string, Quota>();

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders()) {
      if (wrapper.instance instanceof QuotaRegistration) {
        for (const quota of wrapper.instance.quotas) {
          const other = this.known.get(quota.key);
          if (other && other !== quota) {
            throw new Error(`Quota "${quota.key}" is defined twice.`);
          }
          this.known.set(quota.key, quota);
        }
      }
    }
  }

  // ---- What the modules call -------------------------------------------

  /** The tenant's limit of a quota (null: unlimited). `tenantId`: the current tenant. */
  async limitOf(quota: Quota, tenantId = requireTenantId('A quota')) {
    const [own] = await this.db
      .select({ plan: tenantQuotas.plan, limits: tenantQuotas.limits })
      .from(tenantQuotas)
      .where(eq(tenantQuotas.tenantId, tenantId));
    if (own?.limits[quota.key] !== undefined) {
      return own.limits[quota.key]!;
    }
    const plans = await this.db
      .select({ name: quotaPlans.name, limits: quotaPlans.limits })
      .from(quotaPlans)
      .where(
        inArray(quotaPlans.name, [own?.plan ?? DEFAULT_PLAN, DEFAULT_PLAN]),
      );
    const named = plans.find((plan) => plan.name === own?.plan);
    const fallback = plans.find((plan) => plan.name === DEFAULT_PLAN);
    return (
      named?.limits[quota.key] ??
      fallback?.limits[quota.key] ??
      quota.default ??
      null
    );
  }

  /**
   * 422 `quota_exceeded` when `adding` more would pass the tenant's limit of
   * a stock quota. Call it in the transaction that makes the thing, before
   * the insert: it takes a lock on the tenant, so two parallel creates
   * between the check and their commit never both pass the last place. A
   * tenant with no limit takes no lock.
   */
  async assertRoom(quota: StockQuota, adding = 1) {
    const tenantId = requireTenantId('A quota check');
    const limit = await this.limitOf(quota, tenantId);
    if (limit === null) {
      return;
    }
    // FOR NO KEY UPDATE doesn't block the foreign key checks of inserts.
    await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .for('no key update');
    const used = await quota.count(this.db, tenantId);
    if (used + adding > limit) {
      throw new UnprocessableEntityException({
        code: 'quota_exceeded',
        message: t('quotas.stockExceeded', {
          args: { label: quota.label, limit, used },
        }),
        quota: { key: quota.key, limit, used },
      });
    }
  }

  /**
   * Takes `amount` of a rate quota, atomically across replicas: past the
   * limit nothing is taken and `allowed` is false. Redis unreachable: allowed,
   * uncounted, logged (an outage lets work through).
   */
  async tryConsume(
    quota: RateQuota,
    amount = 1,
    tenantId = requireTenantId('A quota'),
  ): Promise<RateOutcome> {
    const { resetsAt } = periodOf(quota.period);
    const limit = await this.limitOf(quota, tenantId);
    const used = await this.redisCall(async () => {
      const key = this.counterKey(quota, tenantId);
      const [taken] = await this.redis
        .multi()
        .incrby(key, amount)
        .expire(key, secondsUntil(resetsAt) + 86_400, 'NX')
        .exec()
        .then((results) => results!);
      if (taken![0]) {
        throw taken![0];
      }
      return Number(taken![1]);
    });
    if (used === null) {
      return { allowed: true, used: 0, limit, resetsAt };
    }
    if (limit !== null && used > limit) {
      await this.redisCall(() =>
        this.redis.decrby(this.counterKey(quota, tenantId), amount),
      );
      return { allowed: false, used: used - amount, limit, resetsAt };
    }
    return { allowed: true, used, limit, resetsAt };
  }

  /** As `tryConsume()`, refusing with 429 `quota_exceeded`, `retryAfter` and the reset time. */
  async consume(quota: RateQuota, amount = 1, tenantId?: string) {
    const outcome = await this.tryConsume(quota, amount, tenantId);
    if (!outcome.allowed) {
      throw new HttpException(
        {
          code: 'quota_exceeded',
          message: t('quotas.rateExceeded', {
            args: {
              label: quota.label,
              limit: outcome.limit,
              resetsAt: outcome.resetsAt.toISOString(),
            },
          }),
          quota: {
            key: quota.key,
            limit: outcome.limit,
            used: outcome.used,
            resetsAt: outcome.resetsAt.toISOString(),
          },
          // The problem filter sets Retry-After from it.
          retryAfter: secondsUntil(outcome.resetsAt),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return outcome;
  }

  /** What the tenant uses of a quota now, in its scope (stock quotas count there). */
  async used(quota: Quota, tenantId = requireTenantId('A quota')) {
    if (quota.kind === 'stock') {
      return quota.count(this.db, tenantId);
    }
    return Number(
      (await this.redisCall(() =>
        this.redis.get(this.counterKey(quota, tenantId)),
      )) ?? 0,
    );
  }

  // ---- The operators' API ----------------------------------------------

  /** A tenant's plan, limits and use of every quota (a 404 for an unknown tenant). */
  async view(tenantId: string) {
    if (!(await this.tenancy.find(tenantId))) {
      throw new NotFoundException(t('quotas.tenantNotFound'));
    }
    return this.tenancy.run(tenantId, async () => {
      const [own] = await this.db
        .select({ plan: tenantQuotas.plan, limits: tenantQuotas.limits })
        .from(tenantQuotas)
        .where(eq(tenantQuotas.tenantId, tenantId));
      const quotas = [];
      for (const quota of this.known.values()) {
        quotas.push({
          key: quota.key,
          label: quota.label,
          description: quota.description ?? null,
          kind: quota.kind,
          period: quota.kind === 'rate' ? quota.period : null,
          used: await this.used(quota, tenantId),
          limit: await this.limitOf(quota, tenantId),
          resetsAt:
            quota.kind === 'rate'
              ? periodOf(quota.period).resetsAt.toISOString()
              : null,
        });
      }
      return {
        tenantId,
        plan: own?.plan ?? null,
        limits: own?.limits ?? {},
        quotas,
      };
    });
  }

  /** Sets a tenant's plan and own limits, merged into what it has; audited in the operators' tenant and in the tenant's. */
  async setTenantLimits(
    operator: Principal,
    tenantId: string,
    changes: SetTenantQuotas,
    ip?: string,
  ) {
    const tenant = await this.tenancy.find(tenantId);
    if (!tenant) {
      throw new NotFoundException(t('quotas.tenantNotFound'));
    }
    this.assertKnown(Object.keys(changes.limits ?? {}), 'limits');
    if (changes.plan) {
      await this.assertPlan(changes.plan);
    }
    const entry = await this.txHost.withTransaction(async () => {
      const [current] = await this.db
        .select()
        .from(tenantQuotas)
        .where(eq(tenantQuotas.tenantId, tenantId))
        .for('update');
      const limits = { ...current?.limits };
      const changed: Record<
        string,
        { from: number | null; to: number | null }
      > = {};
      for (const [key, value] of Object.entries(changes.limits ?? {})) {
        const from = limits[key] ?? null;
        if (value === null) delete limits[key];
        else limits[key] = value;
        if (from !== value) changed[key] = { from, to: value };
      }
      const from = current?.plan ?? null;
      const plan = changes.plan === undefined ? from : changes.plan;
      if (plan === null && Object.keys(limits).length === 0) {
        await this.db
          .delete(tenantQuotas)
          .where(eq(tenantQuotas.tenantId, tenantId));
      } else {
        await this.db
          .insert(tenantQuotas)
          .values({ tenantId, plan, limits })
          .onConflictDoUpdate({
            target: tenantQuotas.tenantId,
            set: { plan, limits },
          });
      }
      const entry = {
        action: 'tenant.quotas-changed',
        targetType: 'tenant',
        targetId: tenantId,
        details: {
          slug: tenant.slug,
          ...(from !== plan && { plan: { from, to: plan } }),
          ...(Object.keys(changed).length > 0 && { limits: changed }),
        },
        ip,
      };
      await this.audit.record(operator, entry);
      return entry;
    });
    if (tenantId !== this.tenancy.current()?.tenantId) {
      await this.tenancy.run(tenantId, () =>
        this.audit.record(operator, entry),
      );
    }
    return this.view(tenantId);
  }

  async plans() {
    return this.db
      .select({ name: quotaPlans.name, limits: quotaPlans.limits })
      .from(quotaPlans)
      .orderBy(quotaPlans.name);
  }

  /** Creates or replaces a plan's limits; audited. */
  async savePlan(
    operator: Principal,
    name: string,
    limits: Record<string, number>,
    ip?: string,
  ) {
    this.assertKnown(Object.keys(limits), 'limits');
    await this.txHost.withTransaction(async () => {
      await this.db
        .insert(quotaPlans)
        .values({ name, limits })
        .onConflictDoUpdate({ target: quotaPlans.name, set: { limits } });
      await this.audit.record(operator, {
        action: 'quota.plan-saved',
        targetType: 'quota-plan',
        targetId: name,
        details: { limits },
        ip,
      });
    });
    return { name, limits };
  }

  /** Deletes a plan: its tenants fall back to the default plan; audited. */
  async deletePlan(operator: Principal, name: string, ip?: string) {
    await this.txHost.withTransaction(async () => {
      const deleted = await this.db
        .delete(quotaPlans)
        .where(eq(quotaPlans.name, name))
        .returning({ name: quotaPlans.name });
      if (deleted.length === 0) {
        throw new NotFoundException(t('quotas.planNotFound'));
      }
      await this.audit.record(operator, {
        action: 'quota.plan-deleted',
        targetType: 'quota-plan',
        targetId: name,
        ip,
      });
    });
  }

  // ---- Internals --------------------------------------------------------

  private counterKey(quota: RateQuota, tenantId: string) {
    return `tenant:${tenantId}:quota:${quota.key}:${periodOf(quota.period).id}`;
  }

  /** A Redis call that never fails the work: null when Redis can't answer (logged). */
  private async redisCall<T>(call: () => Promise<T>): Promise<T | null> {
    if (this.redis.status !== 'ready') {
      this.logger.warn(`Quota not counted: Redis is ${this.redis.status}`);
      return null;
    }
    try {
      return await call();
    } catch (error) {
      this.logger.warn(`Quota not counted: ${(error as Error).message}`);
      return null;
    }
  }

  private assertKnown(keys: string[], path: string) {
    const unknown = keys.filter((key) => !this.known.has(key));
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: t('quotas.unknownKey', { args: { key: unknown[0] } }),
        errors: unknown.map((key) => ({
          path: `${path}.${key}`,
          message: t('quotas.unknownKey', { args: { key } }),
        })),
      });
    }
  }

  private async assertPlan(name: string) {
    const [plan] = await this.db
      .select({ name: quotaPlans.name })
      .from(quotaPlans)
      .where(eq(quotaPlans.name, name));
    if (!plan) {
      throw new BadRequestException({
        code: 'validation_failed',
        message: t('quotas.unknownPlan', { args: { name } }),
        errors: [
          {
            path: 'plan',
            message: t('quotas.unknownPlan', { args: { name } }),
          },
        ],
      });
    }
  }
}

const secondsUntil = (at: Date) =>
  Math.max(1, Math.ceil((at.getTime() - Date.now()) / 1000));
