import { Controller, Get, Module } from '@nestjs/common';
import { ApiClientsModule } from '../../iam/api-clients/api-clients.module.js';
import { Can } from '@nestjs/authorization';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { accessModules, member, seededAdmin } from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { addDays, utcDay } from './usage.keys.js';
import { apiUsage } from './usage.tables.js';
import { UsageModule } from './usage.module.js';
import { UsageRollupJob } from './usage-rollup.job.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-usage-${process.pid}-${Date.now()}`;
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
});

/** A route of its own, so the tests do not meter the usage routes themselves. */
@Controller('ping')
class PingController {
  @Get()
  @Can.Anyone()
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class PingModule {}

describe('API usage (e2e)', () => {
  let app: NestNodeApplication;
  let admin: Awaited<ReturnType<typeof seededAdmin>>;

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(admin.tenantId, work);

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      ApiClientsModule,
      UsageModule,
      PingModule,
    );
    admin = await seededAdmin(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  /** A client that called /v1/ping `times` times (the count lands after the response). */
  async function pingedClient(times: number) {
    const client = await apiClient(app, admin.tenantId);
    for (let i = 0; i < times; i++) {
      expect((await call('GET', '/v1/ping', client.headers)).statusCode).toBe(
        200,
      );
    }
    return client;
  }

  const usageOf = (clientId: string) =>
    call(
      'GET',
      `/v1/access/clients/${clientId}/usage?from=${utcDay()}`,
      admin.headers,
    );

  it('counts a client’s requests per route pattern, for the client and its administrators', async () => {
    const client = await pingedClient(3);
    await vi.waitFor(async () => {
      const seen = await usageOf(client.client.id);
      expect(seen.statusCode).toBe(200);
      expect(seen.json()).toEqual({
        from: utcDay(),
        to: utcDay(),
        days: [{ day: utcDay(), total: 3, routes: { 'GET /v1/ping': 3 } }],
        total: 3,
        dailyQuota: null,
      });
    });
    // The client's own view: 30 days ending today, zeros included.
    const own = (await call('GET', '/v1/usage', client.headers)).json();
    expect(own.to).toBe(utcDay());
    expect(own.from).toBe(addDays(utcDay(), -29));
    expect(own.days).toHaveLength(30);
    expect(own.days.at(-1).routes['GET /v1/ping']).toBe(3);
    // Administrators' own requests are never counted: the client's total only moved by its own.
    await call('GET', '/v1/ping', admin.headers);
    await vi.waitFor(async () =>
      expect((await usageOf(client.client.id)).json().total).toBe(4),
    );
  });

  it('sets a new client’s daily quota with its create, in one request', async () => {
    const created = await call('POST', '/v1/access/clients', admin.headers, {
      name: `metered-${Date.now()}`,
      dailyQuota: 7,
    });
    expect(created.statusCode, created.body).toBe(201);
    const usage = await usageOf(created.json().id);
    expect(usage.json()).toMatchObject({ dailyQuota: 7 });
  });

  it('keeps usage to those who may read it, and checks the range', async () => {
    const client = await apiClient(app, admin.tenantId);
    const viewer = await member(app, admin.tenantId, ['viewer']);
    expect(
      (
        await call(
          'GET',
          `/v1/access/clients/${client.client.id}/usage`,
          viewer.headers,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'PUT',
          `/v1/access/clients/${client.client.id}/daily-quota`,
          viewer.headers,
          { dailyQuota: 5 },
        )
      ).statusCode,
    ).toBe(403);
    const asUser = await call('GET', '/v1/usage', admin.headers);
    expect(asUser.statusCode).toBe(403);
    expect((await call('GET', '/v1/usage', {})).statusCode).toBe(401);
    const unknown = '0199a3f2-0000-7000-8000-000000000000';
    expect(
      (await call('GET', `/v1/access/clients/${unknown}/usage`, admin.headers))
        .statusCode,
    ).toBe(404);
    const backwards = await call(
      'GET',
      `/v1/access/clients/${client.client.id}/usage?from=2026-02-02&to=2026-02-01`,
      admin.headers,
    );
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().code).toBe('validation_failed');
    expect(
      (
        await call(
          'GET',
          `/v1/access/clients/${client.client.id}/usage?from=2020-01-01&to=2026-01-01`,
          admin.headers,
        )
      ).statusCode,
    ).toBe(400);
  });

  it('holds a burst of parallel requests to exactly the daily quota, and refuses the rest with 429', async () => {
    const client = await apiClient(app, admin.tenantId);
    const set = await call(
      'PUT',
      `/v1/access/clients/${client.client.id}/daily-quota`,
      admin.headers,
      { dailyQuota: 5 },
    );
    expect(set.json()).toEqual({ dailyQuota: 5 });
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => call('GET', '/v1/ping', client.headers)),
    );
    expect(answers.map((a) => a.statusCode).sort((a, b) => a - b)).toEqual([
      200, 200, 200, 200, 200, 429, 429, 429, 429, 429, 429, 429,
    ]);
    // The ones let through took places 1 to 5.
    expect(
      answers
        .filter((a) => a.statusCode === 200)
        .map((a) => Number(a.headers['x-quota-remaining']))
        .sort((a, b) => a - b),
    ).toEqual([0, 1, 2, 3, 4]);
    const refused = answers.find((a) => a.statusCode === 429)!;
    expect(refused.json().code).toBe('quota_exceeded');
    expect(refused.headers['x-quota-limit']).toBe('5');
    expect(refused.headers['x-quota-remaining']).toBe('0');
    const reset = Number(refused.headers['x-quota-reset']);
    expect(reset).toBeGreaterThan(0);
    expect(reset).toBeLessThanOrEqual(86_400);
    expect(refused.headers['retry-after']).toBe(String(reset));
    // The refused ones were given back: exactly 5 are counted.
    await vi.waitFor(async () =>
      expect((await usageOf(client.client.id)).json()).toMatchObject({
        total: 5,
        dailyQuota: 5,
      }),
    );

    // Audited; null lifts the quota, 0 is refused.
    const [entry] = await inTenant(() =>
      db()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'client.quota-changed'),
            eq(auditLog.targetId, client.client.id),
          ),
        ),
    );
    expect(entry!.details).toEqual({ dailyQuota: { from: null, to: 5 } });
    await call(
      'PUT',
      `/v1/access/clients/${client.client.id}/daily-quota`,
      admin.headers,
      { dailyQuota: null },
    );
    const free = await call('GET', '/v1/ping', client.headers);
    expect(free.statusCode).toBe(200);
    expect(free.headers['x-quota-limit']).toBeUndefined();
    expect(
      (
        await call(
          'PUT',
          `/v1/access/clients/${client.client.id}/daily-quota`,
          admin.headers,
          { dailyQuota: 0 },
        )
      ).statusCode,
    ).toBe(400);
  });

  it('rolls the counters up into the table, answers the same from it, and deletes old rows', async () => {
    const client = await pingedClient(2);
    const job = app.get(UsageRollupJob);
    await vi.waitFor(async () =>
      expect((await usageOf(client.client.id)).json().total).toBe(2),
    );

    expect(await job.run(utcDay())).toBeGreaterThanOrEqual(1);
    const rows = await inTenant(() =>
      db()
        .select()
        .from(apiUsage)
        .where(eq(apiUsage.clientId, client.client.id)),
    );
    expect(Object.fromEntries(rows.map((r) => [r.route, r.count]))).toEqual({
      'GET /v1/ping': 2,
    });
    const before = (await usageOf(client.client.id)).json();

    // The night after: today's counters copied, then deleted; the table answers alone.
    const tomorrow = new Date(Date.parse(`${addDays(utcDay(), 1)}T00:20:00Z`));
    await job.run(undefined, tomorrow);
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
    const keys = await redis
      .keys(
        `${process.env.REDIS_PREFIX}:tenant:${admin.tenantId}:usage:${client.client.id}:*`,
      )
      .finally(() => redis.disconnect());
    expect(keys).toEqual([]);
    expect((await usageOf(client.client.id)).json()).toEqual(before);

    // Older than USAGE_RETENTION_DAYS (400): deleted.
    const old = addDays(utcDay(), -401);
    await inTenant(() =>
      db().insert(apiUsage).values({
        clientId: client.client.id,
        day: old,
        route: 'GET /v1/ping',
        count: 7,
      }),
    );
    await job.run();
    expect(
      await inTenant(() =>
        db()
          .select({ day: apiUsage.day })
          .from(apiUsage)
          .where(
            and(eq(apiUsage.clientId, client.client.id), eq(apiUsage.day, old)),
          ),
      ),
    ).toEqual([]);
  });
});
