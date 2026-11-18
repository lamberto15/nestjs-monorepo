import type { NestNodeApplication } from '@nestjs/platform-node';
import { getDrizzleToken } from '@nestjs/drizzle';
import { apiClient } from '../../../test/auth.js';
import { roleIds } from '../../../test/access.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { apiClientRoles } from '../../iam/access/access.tables.js';
import { bootModules } from '../../../test/boot.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { deliverWebhooks, webhookReceiver } from '../../../test/webhooks.js';
import { WebhooksModule } from './webhooks.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.OUTBOX_RELAY = 'off';
  process.env.WEBHOOKS_WORKER = 'off';
  process.env.WEBHOOKS_ALLOW_LOOPBACK = 'on';
  process.env.DATA_ENCRYPTION_KEYS =
    'ZmFrZS10ZXN0LWtleS1mb3Itd2ViaG9va3MtZTJlLTAx';
  process.env.REDIS_PREFIX = `test-record-webhooks-${process.pid}-${Date.now()}`;
});

describe('a record as webhooks (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      WebhooksModule,
      testItemsModule({ imports: [WebhooksModule.forRecord(TEST_ITEM)] }),
    );
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('lists the record events as event types', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/webhook-event-types',
      headers: team.admin.headers,
    });
    const group = res
      .json<{ items: { group: string; types: { type: string }[] }[] }>()
      .items.find((each) => each.group === 'testItem');
    expect(group?.types.map((each) => each.type)).toEqual([
      'testItem.created',
      'testItem.deleted',
      'testItem.restored',
      'testItem.updated',
    ]);
  });

  it('sends a record to the clients that may read it, and a deletion too', async () => {
    const receiver = await webhookReceiver();
    const strangerReceiver = await webhookReceiver();
    try {
      const owner = await apiClient(app, team.tenantId);
      const stranger = await apiClient(app, team.tenantId);
      for (const [client, url] of [
        [owner, receiver.url],
        [stranger, strangerReceiver.url],
      ] as const) {
        const endpoint = await app.inject({
          method: 'POST',
          url: '/v1/webhook-endpoints',
          headers: client.headers,
          payload: { url, eventTypes: ['*'] },
        });
        expect(endpoint.statusCode).toBe(201);
      }

      // The owner's own record reaches it; a user's does not (clients read their own).
      const own = await createTestItem(app, owner.headers, { title: 'Mine' });
      await createTestItem(app, team.editor.headers, { title: 'Theirs' });
      await app.inject({
        method: 'PATCH',
        url: `/v1/test-items/${own.id}`,
        headers: owner.headers,
        payload: { title: 'Mine, changed' },
      });
      await app.inject({
        method: 'DELETE',
        url: `/v1/test-items/${own.id}`,
        headers: owner.headers,
      });
      await deliverWebhooks(app);

      expect(receiver.received.map((each) => each.body.type).sort()).toEqual([
        'testItem.created',
        'testItem.deleted',
        'testItem.updated',
      ]);
      const created = receiver.received.find(
        (each) => each.body.type === 'testItem.created',
      )!;
      expect(created.body.data).toMatchObject({ id: own.id, title: 'Mine' });
      expect(created.body.data).not.toHaveProperty('tenantId');
      expect(created.body.data).not.toHaveProperty('can');
      const deleted = receiver.received.find(
        (each) => each.body.type === 'testItem.deleted',
      )!;
      expect(deleted.body.data.deletedAt).toEqual(expect.any(String));
      // Another client reads none of them.
      expect(strangerReceiver.received).toEqual([]);
    } finally {
      await receiver.close();
      await strangerReceiver.close();
    }
  });

  it('sends a record to its owner, and to a tenant-scoped client only when its role may read it', async () => {
    const mine = await webhookReceiver();
    const wide = await webhookReceiver();
    const unroled = await webhookReceiver();
    const ownScoped = await webhookReceiver();
    try {
      const owner = await apiClient(app, team.tenantId);
      const tenantReader = await apiClient(app, team.tenantId);
      const noRole = await apiClient(app, team.tenantId);
      const ownReader = await apiClient(app, team.tenantId);
      // The viewer role reads every record; the others' roles read none of a user's.
      const [viewer] = await roleIds(app, team.tenantId, 'viewer');
      const db = app.get<Database>(getDrizzleToken());
      await app.get(Tenancy).run(team.tenantId, () =>
        db.insert(apiClientRoles).values(
          [tenantReader, ownReader].map((each) => ({
            clientId: each.client.id,
            roleId: viewer!,
          })),
        ),
      );
      for (const [client, receiver] of [
        [owner, mine],
        [tenantReader, wide],
        [noRole, unroled],
        [ownReader, ownScoped],
      ] as const) {
        await app.inject({
          method: 'POST',
          url: '/v1/webhook-endpoints',
          headers: client.headers,
          payload: { url: receiver.url, eventTypes: ['*'] },
        });
      }
      const scope = (id: string, value?: string) =>
        app.inject({
          method: value ? 'PUT' : 'GET',
          url: `/v1/access/clients/${id}/webhook-scope`,
          headers: team.admin.headers,
          ...(value && { payload: { scope: value } }),
        });
      expect((await scope(tenantReader.client.id)).json()).toEqual({
        scope: 'own',
      });
      for (const each of [tenantReader, noRole]) {
        expect((await scope(each.client.id, 'tenant')).json()).toEqual({
          scope: 'tenant',
        });
      }
      expect((await scope(tenantReader.client.id)).json()).toEqual({
        scope: 'tenant',
      });

      await createTestItem(app, team.editor.headers, { title: "A user's" });
      await createTestItem(app, owner.headers, { title: "A client's" });
      await deliverWebhooks(app);

      const titles = (receiver: typeof mine) =>
        receiver.received.map((each) => each.body.data.title);
      // The owner hears its own; the tenant-scoped reader (role: viewer) hears both.
      expect(titles(mine)).toEqual(["A client's"]);
      expect(
        titles(wide).sort((a, b) => String(a).localeCompare(String(b))),
      ).toEqual(["A client's", "A user's"]);
      // An own-scoped client with the same wide role hears only its own records (none).
      expect(titles(ownScoped)).toEqual([]);
      // A tenant-scoped client whose role reads nothing gets nothing.
      expect(titles(unroled)).toEqual([]);

      await scope(tenantReader.client.id, 'own');
      expect((await scope(tenantReader.client.id)).json()).toEqual({
        scope: 'own',
      });
    } finally {
      for (const receiver of [mine, wide, unroled, ownScoped]) {
        await receiver.close();
      }
    }
  });
});
