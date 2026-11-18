import { TransactionHost } from '@nestjs-cls/transactional';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { asc, eq } from 'drizzle-orm';
import { CLS_REQ, ClsService } from 'nestjs-cls';
import type { Database, DatabaseTransactions } from '../database/database.js';
import { tenancyConfig } from './tenancy.config.js';
import { type Tenant, tenants } from './tenancy.tables.js';
import { isolation } from './tenant-isolation.js';
import {
  ACROSS_TENANTS,
  currentTenantScope,
  describeScope,
  inheritScope,
  NO_TENANT,
  readOnlyTenantScope,
  requireTenantId,
  sameScope,
  TENANT_SCOPE,
  type TenantScope,
  tenantScope,
} from './tenant-scope.js';

/**
 * The tenant of the current work, and work run as a tenant (README.md).
 * Modules never set a tenant in a query: they run in a scope, and the
 * database binds every query to it.
 */
@Injectable()
export class Tenancy implements OnApplicationBootstrap {
  private readonly logger = new Logger('Tenancy');

  constructor(
    private readonly cls: ClsService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @Inject(tenancyConfig.KEY)
    private readonly config: ConfigType<typeof tenancyConfig>,
  ) {}

  /**
   * `TENANCY=single`: the one tenant exists from the first start, made
   * only when there is none (a tenant moved here, `restore()`, is the one).
   * Not where FIRST_START_SEED is off (the operator CLI).
   */
  async onApplicationBootstrap() {
    if (this.config.mode !== 'single') {
      return;
    }
    if (this.config.seed && (await this.all()).length === 0) {
      // Instances starting together: the slug's unique key keeps it one.
      await this.db
        .insert(tenants)
        .values({ slug: 'default', name: 'Default' })
        .onConflictDoNothing();
    }
    const all = await this.all();
    if (all.length === 0) {
      return;
    }
    if (all.length > 1) {
      this.logger.warn(
        `TENANCY=single with ${all.length} tenants: the oldest, ${all[0]!.slug}, is the one; no more can be made.`,
      );
    }
  }

  /** The tenant of the current context, or a TenantScopeMissingError. */
  tenantId(): string {
    return requireTenantId();
  }

  /** The scope of the current context, or undefined (no request, no job). */
  current(): TenantScope | undefined {
    return currentTenantScope();
  }

  /**
   * Runs `work` as `tenantId` (or with no tenant: `null`), in a context of
   * its own nested in the current one, which is left as it was: for work
   * that starts outside a tenant (a job, a scheduled task) or walks several.
   * Refused inside an open transaction of another scope: a transaction is
   * bound when it begins, so the work would run in the outer one; start the
   * transaction inside instead.
   */
  run<T>(tenantId: string | null, work: () => Promise<T>): Promise<T> {
    return this.runIn(
      tenantId === null ? NO_TENANT : tenantScope(tenantId),
      work,
    );
  }

  /**
   * Puts the rest of the current context (a request's: a guard calls it
   * before the handler) in `tenantId`'s scope. Refused outside a context,
   * and when the context already has another scope: a request belongs to
   * one tenant, decided once. `readOnly` (break-glass): every transaction
   * of the rest of the request is `READ ONLY`, so PostgreSQL refuses any
   * write; a context entered read only stays so.
   */
  enter(tenantId: string, { readOnly = false }: { readOnly?: boolean } = {}) {
    const scope = inheritScope(
      readOnly ? readOnlyTenantScope(tenantId) : tenantScope(tenantId),
    );
    if (!this.cls.isActive()) {
      throw new Error(
        'Tenancy.enter() needs a context (a request): use Tenancy.run() elsewhere.',
      );
    }
    const current = currentTenantScope();
    if (current && !sameScope(current, scope)) {
      throw new Error(
        `This context already runs as ${describeScope(current)}: it can't enter ${describeScope(scope)}.`,
      );
    }
    this.assertNoOtherTransaction(scope);
    this.cls.set(TENANT_SCOPE, scope);
  }

  /**
   * Runs `work` across every tenant at once, for maintenance that sweeps a
   * table whole (retention by age). Its queries run as the maintenance role
   * (DATABASE_MAINTENANCE_URL), refused where that is not configured, and
   * never inside a request. Work that acts per tenant walks them instead
   * (forEachTenant()). Logged with the job's name.
   */
  acrossTenants<T>(job: string, work: () => Promise<T>): Promise<T> {
    if (
      (this.cls.isActive() && this.cls.get(CLS_REQ)) ||
      currentTenantScope()?.readOnly
    ) {
      throw new Error(
        `${job}: work across every tenant never runs in a request.`,
      );
    }
    this.logger.log(`${job}: across every tenant (the maintenance role)`);
    return this.runIn(ACROSS_TENANTS, work);
  }

  /**
   * Runs `work` once per active tenant (every tenant with
   * `includeInactive`), each in that tenant's scope. A tenant's failure is
   * logged and the others still run; then a TenantRunsFailed names them all.
   */
  async forEachTenant<T>(
    job: string,
    work: (tenant: Tenant) => Promise<T>,
    { includeInactive = false }: { includeInactive?: boolean } = {},
  ): Promise<Map<string, T>> {
    const results = new Map<string, T>();
    const failures: { tenant: Tenant; error: unknown }[] = [];
    const walked = (await this.all()).filter(
      (tenant) => includeInactive || tenant.active,
    );
    for (const tenant of walked) {
      try {
        results.set(tenant.id, await this.run(tenant.id, () => work(tenant)));
      } catch (error) {
        failures.push({ tenant, error });
        this.logger.error(
          `${job}: failed for tenant ${tenant.slug}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new TenantRunsFailed(job, failures);
    }
    return results;
  }

  /**
   * Makes a tenant: its row, and its storage where the isolation mode needs
   * one, in one transaction. With TENANCY=single, only the first.
   */
  async create(values: { slug: string; name: string }): Promise<Tenant> {
    return this.txHost.withTransaction(async () => {
      if (this.config.mode === 'single' && (await this.all()).length > 0) {
        throw new ConflictException({
          code: 'single_tenant',
          message: 'This deployment has one tenant (TENANCY=single).',
        });
      }
      const [tenant] = await this.db.insert(tenants).values(values).returning();
      await isolation.provision(this.db, tenant!.id);
      return tenant!;
    });
  }

  /**
   * Puts back a tenant moved from another server (modules/tenant-move): its
   * row as it was there (id, slug, name, dates), not frozen, and its
   * storage where the isolation mode needs one, in the caller's
   * transaction. With TENANCY=single, only while there is none: it is then
   * the one, and the first start makes no other.
   */
  async restore(tenant: Tenant): Promise<Tenant> {
    return this.txHost.withTransaction(async () => {
      if (this.config.mode === 'single' && (await this.all()).length > 0) {
        throw new ConflictException({
          code: 'single_tenant',
          message: 'This deployment has one tenant (TENANCY=single).',
        });
      }
      const [restored] = await this.db
        .insert(tenants)
        .values({ ...tenant, frozenAt: null })
        .returning();
      await isolation.provision(this.db, restored!.id);
      return restored!;
    });
  }

  /**
   * Freezes a tenant (read only for everyone, from its next transaction on:
   * row-level-security.ts) or thaws it. Run outside the tenant's scope: a
   * frozen tenant's own transactions can't write, this one included.
   * Returns the tenant, or undefined when there is none.
   */
  async setFrozen(id: string, frozen: boolean): Promise<Tenant | undefined> {
    const [tenant] = await this.db
      .update(tenants)
      .set({ frozenAt: frozen ? new Date() : null })
      .where(eq(tenants.id, id))
      .returning();
    return tenant;
  }

  /** One tenant by id, active or not. */
  async find(id: string): Promise<Tenant | undefined> {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, id));
    return tenant;
  }

  /** With TENANCY=single, the tenant: what sign-in enters, since nothing asks which. */
  async soleTenant(): Promise<Tenant> {
    const [tenant] = await this.all();
    if (this.config.mode !== 'single' || !tenant) {
      throw new Error(
        'Tenancy.soleTenant() is for TENANCY=single, once its tenant exists.',
      );
    }
    return tenant;
  }

  private get db(): Database {
    return this.txHost.tx;
  }

  /** Every tenant, oldest first. Global: readable in any scope. */
  private all() {
    return this.db
      .select()
      .from(tenants)
      .orderBy(asc(tenants.createdAt), asc(tenants.id));
  }

  private runIn<T>(asked: TenantScope, work: () => Promise<T>): Promise<T> {
    const scope = inheritScope(asked);
    this.assertNoOtherTransaction(scope);
    // Awaited inside: a Drizzle query runs when awaited, in this context.
    return this.cls.run({ ifNested: 'inherit' }, async () => {
      this.cls.set(TENANT_SCOPE, scope);
      return await work();
    });
  }

  private assertNoOtherTransaction(scope: TenantScope) {
    if (!this.cls.isActive() || !this.txHost.isTransactionActive()) {
      return;
    }
    const outer = currentTenantScope();
    if (!sameScope(outer, scope)) {
      throw new Error(
        `A transaction of ${describeScope(outer)} is open: work as ${describeScope(scope)} must start its own, outside it.`,
      );
    }
  }
}

/** Some tenants' runs of a job failed (each logged); the others ran. */
export class TenantRunsFailed extends AggregateError {
  constructor(
    job: string,
    readonly failures: { tenant: Tenant; error: unknown }[],
  ) {
    super(
      failures.map((failure) => failure.error),
      `${job} failed for ${failures.length} tenant(s): ${failures
        .map(
          ({ tenant, error }) =>
            `${tenant.slug} (${error instanceof Error ? error.message : String(error)})`,
        )
        .join('; ')}`,
    );
  }
}
