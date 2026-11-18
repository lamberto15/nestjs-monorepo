import { getQueueToken } from '@nestjs/bullmq';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { member } from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RolesService } from '../../iam/access/roles.service.js';
import { userRoles } from '../../iam/access/access.tables.js';
import { AccessService } from '../../iam/access/access.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { DataTransferModule } from './data-transfer.module.js';
import { DATA_TRANSFERS } from './data-transfer.service.js';

const OPERATORS = vi.hoisted(() => {
  const slug = `operators-${process.pid}-${Date.now()}`;
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    OPERATOR_TENANT: slug,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-tenant-export-${process.pid}-${Date.now()}`,
  });
  return slug;
});

const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe("a tenant's export by the operators (e2e)", () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  let operator: Record<string, string>;
  let opsId: string;
  let keyHash: string;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      StorageModule,
      testItemsModule({ imports: [DataTransferModule.forRecord(TEST_ITEM)] }),
    );
    const tenancy = app.get(Tenancy);
    const db = app.get<Database>(getDrizzleToken());
    let [ops] = await db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, OPERATORS));
    if (!ops) {
      ops = await tenancy.create({ slug: OPERATORS, name: 'Operators' });
      await tenancy.run(ops.id, () =>
        app
          .get(TransactionHost)
          .withTransaction(() => app.get(RolesService).seedTenantRoles()),
      );
    }
    opsId = ops.id;
    operator = (await member(app, ops.id, ['administrator'])).headers;
    team = await recordsTenant(app);
    const other = await recordsTenant(app);
    await createTestItem(app, team.editor.headers, { title: 'Exported item' });
    await createTestItem(app, other.editor.headers, { title: 'Foreign item' });
    keyHash = (await apiClient(app, team.tenantId)).key;
  });
  afterAll(async () => {
    await app
      ?.get<Queue>(getQueueToken(DATA_TRANSFERS))
      .obliterate({ force: true });
    await app?.close();
  });

  const post = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: `/v1/tenants/${team.tenantId}/export`,
      headers,
      payload: {},
    });

  it('refuses a tenant administrator, and the public export route has no such name', async () => {
    const refused = await post(team.admin.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'operator_required' });
    const named = await app.inject({
      method: 'POST',
      url: '/v1/data/exports',
      headers: operator,
      payload: {
        name: 'tenant',
        format: 'csv',
        filters: { tenantId: team.tenantId },
      },
    });
    expect(named.statusCode).toBe(404);
  });

  it("writes that tenant's rows only, without hashes, secrets or the other tenant's data, and audits it", async () => {
    const started = await post(operator);
    expect(started.statusCode).toBe(202);
    const { id } = started.json<{ id: string }>();
    let transfer:
      | {
          status: string;
          error?: string;
          result?: { url: string; rows: number };
        }
      | undefined;
    await vi.waitFor(
      async () => {
        transfer = (
          await app.inject({
            method: 'GET',
            url: `/v1/data/transfers/${id}`,
            headers: operator,
          })
        ).json();
        expect(JSON.stringify(transfer)).toContain('"completed"');
      },
      { timeout: 10_000, interval: 50 },
    );
    const file = (
      await app.inject({ method: 'GET', url: local(transfer!.result!.url) })
    ).body;
    expect(file.split('\n')[0]).toContain('kind,id,data');
    expect(file).toContain(team.tenantId);
    expect(file).toContain('Exported item');
    expect(file).toMatch(/^member,/m);
    // Another tenant's rows are never in it.
    expect(file).not.toContain('Foreign item');
    // No credential hash: the key's own, or an account's password.
    expect(file).toContain('api_keys');
    expect(file).not.toContain('keyHash');
    expect(file).not.toContain('passwordHash');
    expect(file).not.toContain(keyHash);

    // Audited in the exported tenant's own log too.
    const entries = await app.get(Tenancy).run(team.tenantId, async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/v1/audit-log?action=tenant.export-requested',
          headers: team.admin.headers,
        })
      ).json(),
    );
    expect(JSON.stringify(entries)).toContain('tenant.export-requested');
  });

  it('gives no link to an operator who lost exportTenants since, and keeps the transfer', async () => {
    const leaving = await member(app, opsId, ['administrator']);
    const { id } = (await post(leaving.headers)).json<{ id: string }>();
    const read = async () => {
      const detail = (
        await app.inject({
          method: 'GET',
          url: `/v1/data/transfers/${id}`,
          headers: leaving.headers,
        })
      ).json<{ status: string; result?: { rows: number; url?: string } }>();
      const listed = (
        await app.inject({
          method: 'GET',
          url: '/v1/data/transfers?kind=export',
          headers: leaving.headers,
        })
      )
        .json<{ items: { id: string; result?: { url?: string } }[] }>()
        .items.find((item) => item.id === id);
      return { detail, listed };
    };
    await vi.waitFor(
      async () => expect((await read()).detail.status).toBe('completed'),
      { timeout: 10_000, interval: 50 },
    );
    expect((await read()).detail.result!.url).toEqual(expect.any(String));

    await app
      .get(Tenancy)
      .run(opsId, () =>
        app
          .get<Database>(getDrizzleToken())
          .delete(userRoles)
          .where(eq(userRoles.userId, leaving.id)),
      );
    app.get(AccessService).invalidate();

    const { detail, listed } = await read();
    expect(detail).toMatchObject({
      status: 'completed',
      result: { rows: expect.any(Number) },
    });
    expect(detail.result).not.toHaveProperty('url');
    expect(listed).toMatchObject({ id, status: 'completed' });
    expect(listed!.result).not.toHaveProperty('url');
  });
});
