import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  seededAdmin,
  tenantWithAdmin,
} from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { recordMetrics } from '../../../test/metrics.js';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { defineQuota, type StockQuota } from './quota.js';
import { QuotasModule } from './quotas.module.js';
import { QuotasService } from './quotas.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-quotas-${process.pid}-${Date.now()}`;
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
  process.env.OPERATOR_TENANT = 'operators';
});

/** What a module that owns a limited thing declares, as the docs show. */
const CLIENTS = defineQuota({
  key: 'clients',
  label: 'API clients',
  kind: 'stock',
  count: (db) => db.$count(apiClients),
});
/** What attachments declares: the gauges read this key. */
const STORAGE = defineQuota({
  key: 'storageBytes',
  label: 'bytes of files',
  kind: 'stock',
  count: () => Promise.resolve(1234),
});
/** A second stock quota: its checks must not wait on the first's. */
const SEATS = defineQuota({
  key: 'seats',
  label: 'seats',
  kind: 'stock',
  count: () => Promise.resolve(0),
});
const CALLS = defineQuota({
  key: 'test.callsPerDay',
  label: 'calls a day',
  kind: 'rate',
  period: 'day',
});

@Injectable()
class MakeClients {
  constructor(
    private readonly quotas: QuotasService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @InjectTransaction() private readonly db: Database,
  ) {}

  /** The pattern: check in the transaction that makes the thing. */
  make(name: string) {
    return this.txHost.withTransaction(async () => {
      await this.quotas.assertRoom(CLIENTS);
      await this.db.insert(apiClients).values({ name });
    });
  }

  /** A check of `quota` whose transaction stays open until `release`. */
  hold(quota: StockQuota, release: Promise<void>) {
    return this.txHost.withTransaction(async () => {
      await this.quotas.assertRoom(quota);
      await release;
    });
  }

  check(quota: StockQuota) {
    return this.txHost.withTransaction(() => this.quotas.assertRoom(quota));
  }
}

@Module({
  imports: [QuotasModule.forFeature(CLIENTS, CALLS, STORAGE, SEATS)],
  providers: [MakeClients],
})
class OwnerModule {}

describe('quotas (e2e)', () => {
  let app: NestNodeApplication;
  let operator: Awaited<ReturnType<typeof seededAdmin>>;
  let other: Awaited<ReturnType<typeof tenantWithAdmin>>;

  const call = (
    method: 'GET' | 'PUT' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const asOther = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(other.tenantId, work);
  const status = async (key: string) =>
    (await call('GET', '/v1/quotas', other.admin.headers))
      .json()
      .quotas.find((q: { key: string }) => q.key === key);

  // Registered before the app boots, so its gauges are made on it.
  const recorded = recordMetrics();
  afterAll(() => recorded.stop());
  beforeAll(async () => {
    app = await bootModules(...accessModules(), OwnerModule);
    operator = await seededAdmin(app);
    other = await tenantWithAdmin(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('limits what a tenant has, and parallel creates never pass the last place', async () => {
    const setLimit = (limit: number | null) =>
      call('PUT', `/v1/tenants/${other.tenantId}/quotas`, operator.headers, {
        limits: { clients: limit },
      });
    expect((await setLimit(2)).statusCode).toBe(200);
    const maker = app.get(MakeClients);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => asOther(() => maker.make(`c${i}`))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const refused = (
      results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    ).reason;
    expect(refused.getStatus()).toBe(422);
    expect(refused.getResponse()).toMatchObject({
      code: 'quota_exceeded',
      quota: { key: 'clients', limit: 2, used: 2 },
    });
    expect(await status('clients')).toMatchObject({
      used: 2,
      limit: 2,
      kind: 'stock',
    });
    // Raising it lets the next in; removing it (null) lifts the limit.
    await setLimit(3);
    await asOther(() => maker.make('third'));
    await expect(asOther(() => maker.make('fourth'))).rejects.toMatchObject({
      status: 422,
    });
    await setLimit(null);
    await asOther(() => maker.make('fourth'));
  });

  it('at one place left, of two parallel creates one passes and one is refused', async () => {
    const maker = app.get(MakeClients);
    const used = await asOther(() => app.get(QuotasService).used(CLIENTS));
    await call(
      'PUT',
      `/v1/tenants/${other.tenantId}/quotas`,
      operator.headers,
      {
        limits: { clients: used + 1 },
      },
    );
    const results = await Promise.allSettled([
      asOther(() => maker.make('race-a')),
      asOther(() => maker.make('race-b')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      (
        results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      ).reason.getResponse(),
    ).toMatchObject({ code: 'quota_exceeded', quota: { used: used + 1 } });
    await call(
      'PUT',
      `/v1/tenants/${other.tenantId}/quotas`,
      operator.headers,
      {
        limits: { clients: null },
      },
    );
  });

  it('a check of one quota waits on another check of it, never on one of another quota', async () => {
    const maker = app.get(MakeClients);
    await call(
      'PUT',
      `/v1/tenants/${other.tenantId}/quotas`,
      operator.headers,
      {
        limits: { clients: 1000, seats: 1000 },
      },
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = asOther(() => maker.hold(CLIENTS, gate));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const timeout = () =>
      new Promise((resolve) => setTimeout(() => resolve('waited'), 1000));
    // Another quota of the same tenant goes through while the first is held.
    expect(
      await Promise.race([
        asOther(() => maker.check(SEATS)).then(() => 'passed'),
        timeout(),
      ]),
    ).toBe('passed');
    // The same quota waits for the commit.
    const same = asOther(() => maker.check(CLIENTS)).then(() => 'passed');
    expect(await Promise.race([same, timeout()])).toBe('waited');
    release();
    await held;
    expect(await same).toBe('passed');
    await call(
      'PUT',
      `/v1/tenants/${other.tenantId}/quotas`,
      operator.headers,
      {
        limits: { clients: null, seats: null },
      },
    );
  });

  it('reports what each tenant stores and its limit (core/metrics), the limit only where there is one', async () => {
    const slug = (await app.get(Tenancy).find(other.tenantId))!.slug;
    await call(
      'PUT',
      `/v1/tenants/${other.tenantId}/quotas`,
      operator.headers,
      {
        limits: { storageBytes: 5000 },
      },
    );
    const stored = await recorded.read('tenant_storage_bytes');
    expect(stored).toContainEqual({
      attributes: { tenant: slug },
      value: 1234,
    });
    expect(stored).toContainEqual({
      attributes: { tenant: 'operators' },
      value: 1234,
    });
    const limits = await recorded.read('tenant_storage_limit_bytes');
    expect(limits).toContainEqual({
      attributes: { tenant: slug },
      value: 5000,
    });
    expect(limits.map((point) => point.attributes.tenant)).not.toContain(
      'operators',
    );
  });

  it('limits what a tenant uses per period: 429 with the reset time, nothing taken past it', async () => {
    const quotas = app.get(QuotasService);
    await call(
      'PUT',
      `/v1/tenants/${other.tenantId}/quotas`,
      operator.headers,
      { limits: { 'test.callsPerDay': 2 } },
    );
    const consume = (n = 1) => asOther(() => quotas.consume(CALLS, n));
    expect((await consume()).used).toBe(1);
    expect((await consume()).used).toBe(2);
    const refused = await consume().catch((error) => error);
    expect(refused.getStatus()).toBe(429);
    expect(refused.getResponse()).toMatchObject({
      code: 'quota_exceeded',
      quota: { key: 'test.callsPerDay', limit: 2, used: 2 },
    });
    expect(refused.getResponse().retryAfter).toBeGreaterThan(0);
    expect(
      new Date(refused.getResponse().quota.resetsAt).getTime(),
    ).toBeGreaterThan(Date.now());
    // The refused one took nothing; tryConsume answers instead of throwing.
    expect(await status('test.callsPerDay')).toMatchObject({
      used: 2,
      limit: 2,
      period: 'day',
    });
    expect(await asOther(() => quotas.tryConsume(CALLS))).toMatchObject({
      allowed: false,
      used: 2,
    });
    // Another tenant has its own counter and no limit.
    expect(
      (
        await app
          .get(Tenancy)
          .run(operator.tenantId, () => quotas.tryConsume(CALLS, 5))
      ).allowed,
    ).toBe(true);
  });

  it('resolves a limit from the tenant, its plan, the default plan, then the quota', async () => {
    const quotas = app.get(QuotasService);
    const limit = () => asOther(() => quotas.limitOf(CLIENTS));
    const tenantUrl = `/v1/tenants/${other.tenantId}/quotas`;
    await call('PUT', tenantUrl, operator.headers, {
      limits: { clients: null },
    });
    expect(await limit()).toBeNull();
    expect(
      (
        await call('PUT', '/v1/quotas/plans/default', operator.headers, {
          limits: { clients: 50 },
        })
      ).statusCode,
    ).toBe(200);
    expect(await limit()).toBe(50);
    await call('PUT', '/v1/quotas/plans/pro', operator.headers, {
      limits: { clients: 500 },
    });
    expect(
      (await call('PUT', tenantUrl, operator.headers, { plan: 'pro' })).json()
        .plan,
    ).toBe('pro');
    expect(await limit()).toBe(500);
    await call('PUT', tenantUrl, operator.headers, { limits: { clients: 7 } });
    expect(await limit()).toBe(7);
    // Deleting the plan sends the tenant back to the default plan.
    await call('PUT', tenantUrl, operator.headers, {
      limits: { clients: null },
    });
    expect(
      (await call('DELETE', '/v1/quotas/plans/pro', operator.headers))
        .statusCode,
    ).toBe(204);
    expect(await limit()).toBe(50);
    expect(
      (await call('GET', '/v1/quotas/plans', operator.headers)).json(),
    ).toEqual([{ name: 'default', limits: { clients: 50 } }]);
    await call('DELETE', '/v1/quotas/plans/default', operator.headers);
  });

  it('is the operators’ to set, refuses unknown keys and plans, and audits in both tenants', async () => {
    const url = `/v1/tenants/${other.tenantId}/quotas`;
    const denied = await call('PUT', url, other.admin.headers, {
      limits: { clients: 5 },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('operator_required');
    expect((await call('GET', url, other.admin.headers)).statusCode).toBe(403);
    expect(
      (await call('PUT', url, operator.headers, { limits: { widgets: 1 } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', url, operator.headers, { plan: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', url, operator.headers, { surprise: 1 })).statusCode,
    ).toBe(400);
    const unknown = '0199a3f2-0000-7000-8000-000000000000';
    expect(
      (await call('PUT', `/v1/tenants/${unknown}/quotas`, operator.headers, {}))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', '/v1/quotas/plans/ghost', operator.headers))
        .statusCode,
    ).toBe(404);
    await call('PUT', url, operator.headers, { limits: { clients: 9 } });
    const entries = (tenantId: string) =>
      app.get(Tenancy).run(tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'tenant.quotas-changed'),
              eq(auditLog.targetId, other.tenantId),
            ),
          ),
      );
    expect((await entries(operator.tenantId)).length).toBeGreaterThan(0);
    expect((await entries(other.tenantId)).length).toBeGreaterThan(0);
    // The tenant's own administrators read their use, never set it.
    expect(
      (await call('GET', '/v1/quotas', other.admin.headers)).statusCode,
    ).toBe(200);
    // An API client has no permission on quotas.
    const client = await apiClient(app, other.tenantId);
    expect((await call('GET', '/v1/quotas', client.headers)).statusCode).toBe(
      403,
    );
  });
});
