import { createHmac, randomUUID } from 'node:crypto';
import { Transactional } from '@nestjs-cls/transactional';
import { Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { WebhookEndpoints } from '@nestjs/webhooks';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { member, tenantWithAdmin } from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import {
  deliverWebhooks,
  webhookModules,
  webhookReceiver,
} from '../../../test/webhooks.js';
import type { Database } from '../../core/database/database.js';
import { MetricsService } from '../../core/metrics/metrics.service.js';
import { defineEvent, Events } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { definePermissions } from '../../iam/access/permissions.js';
import { API_CLIENT_EVENTS } from '../../iam/api-clients/api-clients.events.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import { WebhookDeliveryRetentionJob } from './webhook-delivery-retention.job.js';
import { storeDeliveries } from './webhook-store.view.js';
import { WebhooksModule } from './webhooks.module.js';
import { webhookDeliveryRequests } from './webhooks.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.OUTBOX_RELAY = 'off';
  process.env.WEBHOOKS_WORKER = 'off';
  process.env.WEBHOOKS_ALLOW_LOOPBACK = 'on';
  process.env.DATA_ENCRYPTION_KEYS =
    'ZmFrZS10ZXN0LWtleS1mb3Itd2ViaG9va3MtZTJlLTAx';
  process.env.REDIS_PREFIX = `test-webhooks-${process.pid}-${Date.now()}`;
});

// A module of the test's own whose events become webhooks: every API client
// may read a Probe, none a Hidden.
const probeHappened = defineEvent<{ id: string; internal: string }>(
  'probe.happened',
);
const hiddenHappened = defineEvent<{ id: string }>('hidden.happened');

const PROBE_PERMISSIONS = definePermissions({
  subjects: {
    Probe: { actions: { read: [] } },
    Hidden: { actions: { read: [] } },
  },
  clientPermissions: [{ subject: 'Probe', action: 'read', conditions: [] }],
});

@Injectable()
class ProbeWriter {
  constructor(private readonly events: Events) {}

  @Transactional()
  async happen(id: string) {
    await this.events.publish(probeHappened, { id, internal: 'not public' });
    await this.events.publish(hiddenHappened, { id });
  }
}

@Module({
  imports: [
    AccessModule.forFeature(PROBE_PERMISSIONS),
    WebhooksModule.forFeature([
      {
        event: probeHappened,
        subject: 'Probe',
        description: 'A probe happened.',
        data: z.object({ id: z.string() }),
      },
      {
        event: hiddenHappened,
        subject: 'Hidden',
        description: 'Nobody may read this.',
        data: z.object({ id: z.string() }),
      },
    ]),
  ],
  providers: [ProbeWriter],
})
class ProbeModule {}

type Headers = Record<string, string>;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY = 86_400_000;

describe('outgoing webhooks (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Headers;
  const db = () => app.get<Database>(getDrizzleToken());
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers = {},
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const base = (clientId: string) => `/v1/access/clients/${clientId}`;
  const client = async () => {
    const created = await apiClient(app, tenantId);
    return { id: created.client.id, headers: created.headers };
  };
  const audit = (targetId: string) =>
    app
      .get(Tenancy)
      .run(tenantId, () =>
        db().select().from(auditLog).where(eq(auditLog.targetId, targetId)),
      );

  beforeAll(async () => {
    app = await bootModules(...webhookModules(), ProbeModule);
    ({
      tenantId,
      admin: { headers: admin },
    } = await tenantWithAdmin(app));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('reports the delivery lag on /metrics', async () => {
    const { body } = await app.get(MetricsService).scrape();
    expect(body).toMatch(/^webhook_delivery_lag_seconds \d+(\.\d+)?$/m);
  });

  it('lists the declared event types by module, for a user and a client, not the test event', async () => {
    const res = await call('GET', '/v1/webhook-event-types', admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      {
        group: 'hidden',
        types: [
          {
            type: 'hidden.happened',
            description: 'Nobody may read this.',
            subject: 'Hidden',
          },
        ],
      },
      {
        group: 'probe',
        types: [
          {
            type: 'probe.happened',
            description: 'A probe happened.',
            subject: 'Probe',
          },
        ],
      },
      {
        group: 'security',
        types: [
          {
            type: 'security.api-key-rotated',
            description:
              "This client's keys were rotated: a new key, and when the previous ones stop working.",
            subject: 'ApiKey',
          },
        ],
      },
    ]);
    const { headers } = await client();
    const asClient = await call('GET', '/v1/webhook-event-types', headers);
    expect(asClient.json()).toEqual(res.json());
    expect((await call('GET', '/v1/webhook-event-types')).statusCode).toBe(401);
  });

  it("manages a client's endpoints on its behalf, which the client sees as its own; audited as the user's", async () => {
    const owner = await client();
    const created = await call(
      'POST',
      `${base(owner.id)}/webhook-endpoints`,
      admin,
      {
        url: 'https://hooks.example.com/in',
        eventTypes: ['probe.happened'],
        description: 'CRM',
      },
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().secret).toMatch(/^whsec_/);
    const id = created.json().id as string;

    const own = await call('GET', `/v1/webhook-endpoints/${id}`, owner.headers);
    expect(own.json()).toMatchObject({
      id,
      description: 'CRM',
      tenant: owner.id,
    });
    expect(own.json()).not.toHaveProperty('secret');
    const list = await call(
      'GET',
      `${base(owner.id)}/webhook-endpoints`,
      admin,
    );
    expect(list.json().items.map((e: { id: string }) => e.id)).toEqual([id]);

    // description: null clears it; an empty string is refused.
    const empty = await call(
      'PATCH',
      `${base(owner.id)}/webhook-endpoints/${id}`,
      admin,
      { description: '' },
    );
    expect(empty.statusCode).toBe(400);
    const cleared = await call(
      'PATCH',
      `${base(owner.id)}/webhook-endpoints/${id}`,
      admin,
      { description: null },
    );
    expect(cleared.json().description).toBeNull();

    const rotated = await call(
      'POST',
      `${base(owner.id)}/webhook-endpoints/${id}/rotate-secret`,
      admin,
    );
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().secret).toMatch(/^whsec_/);
    expect(rotated.json().secret).not.toBe(created.json().secret);

    const actions = (await audit(owner.id)).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'webhook-endpoint.created',
        'webhook-endpoint.updated',
        'webhook-endpoint.secret-rotated',
      ]),
    );
    expect(JSON.stringify(await audit(owner.id))).not.toContain('whsec_');

    expect(
      (await call('DELETE', `${base(owner.id)}/webhook-endpoints/${id}`, admin))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('GET', `/v1/webhook-endpoints/${id}`, owner.headers))
        .statusCode,
    ).toBe(404);
  });

  it("keeps another client's endpoint out (404), and refuses unknown and reserved types and unsafe URLs (400)", async () => {
    const [a, b] = [await client(), await client()];
    const endpoint = await call('POST', '/v1/webhook-endpoints', a.headers, {
      url: 'https://hooks.example.com/a',
      eventTypes: ['*'],
    });
    expect(endpoint.statusCode).toBe(201);
    const id = endpoint.json().id as string;
    expect(
      (await call('GET', `${base(b.id)}/webhook-endpoints/${id}`, admin))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/webhook-endpoints/${id}`, b.headers)).statusCode,
    ).toBe(404);
    expect(
      (
        await call('PATCH', `/v1/webhook-endpoints/${id}`, b.headers, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `${base(randomUUID())}/webhook-endpoints`, admin))
        .statusCode,
    ).toBe(404);

    for (const eventTypes of [['webhook.test'], ['nobody.declared']]) {
      const refused = await call('POST', '/v1/webhook-endpoints', a.headers, {
        url: 'https://hooks.example.com/t',
        eventTypes,
      });
      expect(refused.statusCode).toBe(400);
    }
    for (const url of [
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/hooks',
      'http://127.0.0.2:8080/hooks',
      'https://[::1]/hooks',
      'http://hooks.example.com/plain',
    ]) {
      const refused = await call('POST', '/v1/webhook-endpoints', a.headers, {
        url,
        eventTypes: ['*'],
      });
      expect({ url, status: refused.statusCode }).toEqual({ url, status: 400 });
    }
  });

  it('refuses an API key (401), a user without the permission (403) and another tenant (404) on the delegated routes', async () => {
    const owner = await client();
    expect(
      (await call('GET', `${base(owner.id)}/webhook-endpoints`, owner.headers))
        .statusCode,
    ).toBe(401);
    const editor = await member(app, tenantId, ['editor']);
    expect(
      (await call('GET', `${base(owner.id)}/webhook-endpoints`, editor.headers))
        .statusCode,
    ).toBe(403);
    const other = await tenantWithAdmin(app);
    expect(
      (
        await call(
          'GET',
          `${base(owner.id)}/webhook-endpoints`,
          other.admin.headers,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('sends webhook.test to the one endpoint, records its request, and pages the log', async () => {
    const receiver = await webhookReceiver();
    try {
      const owner = await client();
      // Subscribed to something else: the test reaches it anyway.
      const endpoint = await call(
        'POST',
        `${base(owner.id)}/webhook-endpoints`,
        admin,
        {
          url: receiver.url,
          eventTypes: ['hidden.happened'],
        },
      );
      const endpointId = endpoint.json().id as string;
      const tested = await call(
        'POST',
        `${base(owner.id)}/webhook-endpoints/${endpointId}/test`,
        admin,
      );
      expect(tested.statusCode).toBe(202);
      expect(tested.json()).toMatchObject({
        endpointId,
        type: 'webhook.test',
        status: 'pending',
        completedAt: null,
      });
      expect(tested.json().id).toMatch(/^dlv_[0-9a-f]{32}$/);
      expect(tested.json().createdAt).toMatch(ISO);
      // Through the client's own route too.
      const second = await call(
        'POST',
        `/v1/webhook-endpoints/${endpointId}/test`,
        owner.headers,
      );
      expect(second.statusCode).toBe(202);

      await deliverWebhooks(app);
      expect(receiver.received.map((w) => w.body.type)).toEqual([
        'webhook.test',
        'webhook.test',
      ]);
      expect(receiver.received[0]!.body.data).toEqual({
        endpointId,
        test: true,
      });

      const delivery = await call(
        'GET',
        `${base(owner.id)}/webhook-deliveries/${tested.json().id}`,
        admin,
      );
      expect(delivery.json()).toMatchObject({
        status: 'succeeded',
        lastRequest: { attempt: 1 },
      });
      expect(delivery.json().durationMs).toBeGreaterThanOrEqual(0);
      expect(delivery.json().history[0].at).toMatch(ISO);
      expect(delivery.json().message.createdAt).toMatch(ISO);
      expect(delivery.json().lastRequest.sentAt).toMatch(ISO);
      expect(delivery.json().lastRequest.headers).toMatchObject({
        'webhook-id': receiver.received[0]!.headers['webhook-id'],
        'webhook-signature': expect.stringMatching(/^v1,/),
      });
      expect(JSON.stringify(delivery.json())).not.toContain('whsec_');

      // Paged, newest first, filtered.
      const first = await call(
        'GET',
        `${base(owner.id)}/webhook-deliveries?limit=1&count=true`,
        admin,
      );
      expect(first.json().items.map((d: { id: string }) => d.id)).toEqual([
        second.json().id,
      ]);
      expect(first.json().total).toBe(2);
      for (const key of ['createdAt', 'lastAttemptAt', 'completedAt']) {
        expect(first.json().items[0][key]).toMatch(ISO);
      }
      const next = await call(
        'GET',
        `${base(owner.id)}/webhook-deliveries?limit=1&cursor=${first.json().nextCursor}`,
        admin,
      );
      expect(next.json().items.map((d: { id: string }) => d.id)).toEqual([
        tested.json().id,
      ]);
      expect(next.json().nextCursor).toBeNull();
      const picked = await call(
        'GET',
        `/v1/webhook-deliveries?fields=createdAt,status`,
        owner.headers,
      );
      expect(Object.keys(picked.json().items[0]).sort()).toEqual([
        'createdAt',
        'id',
        'status',
      ]);
      const failed = await call(
        'GET',
        '/v1/webhook-deliveries?status=failed',
        owner.headers,
      );
      expect(failed.json().items).toEqual([]);
      const createdAt = first.json().items[0].createdAt as string;
      const after = await call(
        'GET',
        `/v1/webhook-deliveries?createdAt.gt=${createdAt}`,
        owner.headers,
      );
      expect(after.json().items).toEqual([]);
      expect(
        (await call('GET', '/v1/webhook-deliveries?cursor=nope', owner.headers))
          .statusCode,
      ).toBe(400);

      // Another client's log shows none of them.
      const other = await client();
      expect(
        (await call('GET', '/v1/webhook-deliveries', other.headers)).json()
          .items,
      ).toEqual([]);
      expect(
        (
          await call(
            'GET',
            `/v1/webhook-deliveries/${tested.json().id}`,
            other.headers,
          )
        ).statusCode,
      ).toBe(404);

      // The user's test is audited; the client's own isn't.
      const tests = (await audit(owner.id)).filter(
        (entry) => entry.action === 'webhook-endpoint.tested',
      );
      expect(tests).toHaveLength(1);

      // A replay: the same webhook-id again.
      const retried = await call(
        'POST',
        `/v1/webhook-deliveries/${tested.json().id}/retry`,
        owner.headers,
      );
      expect(retried.json()).toEqual({ retried: 1 });
      await deliverWebhooks(app);
      expect(receiver.received[2]!.headers['webhook-id']).toBe(
        receiver.received[0]!.headers['webhook-id'],
      );
    } finally {
      await receiver.close();
    }
  });

  it('records which secrets signed each attempt, both during the overlap after a rotation, never the secrets', async () => {
    const receiver = await webhookReceiver();
    try {
      const owner = await client();
      const created = await call(
        'POST',
        `${base(owner.id)}/webhook-endpoints`,
        admin,
        { url: receiver.url, eventTypes: ['*'] },
      );
      const endpoint = `${base(owner.id)}/webhook-endpoints/${created.json().id}`;
      const secrets = [created.json().secret as string];

      const before = await call('POST', `${endpoint}/test`, admin);
      await deliverWebhooks(app);
      const first = await call(
        'GET',
        `${base(owner.id)}/webhook-deliveries/${before.json().id}`,
        admin,
      );
      expect(first.json().lastRequest.signedWith).toEqual([
        { createdAt: expect.stringMatching(ISO), expiresAt: null },
      ]);

      const rotated = await call('POST', `${endpoint}/rotate-secret`, admin);
      secrets.push(rotated.json().secret);
      const during = await call('POST', `${endpoint}/test`, admin);
      await deliverWebhooks(app);
      const second = await call(
        'GET',
        `/v1/webhook-deliveries/${during.json().id}`,
        owner.headers,
      );
      const { signedWith, headers } = second.json().lastRequest;
      // Newest first, as the v1,… signatures are; the old one ends in 24 hours.
      expect(signedWith).toHaveLength(2);
      expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
      expect(signedWith[1]).toEqual({
        createdAt: first.json().lastRequest.signedWith[0].createdAt,
        expiresAt: expect.stringMatching(ISO),
      });
      expect(signedWith[0].expiresAt).toBeNull();
      const overlap = new Date(signedWith[1].expiresAt).getTime() - Date.now();
      expect(overlap).toBeGreaterThan(23 * 3600_000);
      expect(overlap).toBeLessThanOrEqual(24 * 3600_000);

      const raw = JSON.stringify([first.json(), second.json()]);
      for (const secret of secrets) {
        expect(raw).not.toContain(secret.slice('whsec_'.length));
      }
      const list = await call(
        'GET',
        `${base(owner.id)}/webhook-deliveries`,
        admin,
      );
      expect(JSON.stringify(list.json())).not.toContain('signedWith');
    } finally {
      await receiver.close();
    }
  });

  it('sends a domain event to the clients that may read it, with its public data alone, signed', async () => {
    const receiver = await webhookReceiver();
    try {
      const subscriber = await client();
      const created = await call(
        'POST',
        '/v1/webhook-endpoints',
        subscriber.headers,
        { url: receiver.url, eventTypes: ['*'] },
      );
      const secret = created.json().secret as string;
      // A client of another tenant, subscribed to everything too.
      const other = await tenantWithAdmin(app);
      const outsider = await apiClient(app, other.tenantId);
      const outsiderReceiver = await webhookReceiver();
      await call('POST', '/v1/webhook-endpoints', outsider.headers, {
        url: outsiderReceiver.url,
        eventTypes: ['*'],
      });

      const id = randomUUID();
      await app
        .get(Tenancy)
        .run(tenantId, () => app.get(ProbeWriter).happen(id));
      await deliverWebhooks(app);
      await outsiderReceiver.close();

      // Only the readable event, without the payload's undeclared key.
      const mine = receiver.received.filter((w) => w.body.data.id === id);
      expect(mine.map((w) => w.body.type)).toEqual(['probe.happened']);
      expect(mine[0]!.body.data).toEqual({ id });
      expect(outsiderReceiver.received).toEqual([]);

      // Standard Webhooks: v1, the HMAC of id.timestamp.body under the secret's key.
      const { headers, raw } = mine[0]!;
      const expected = createHmac(
        'sha256',
        Buffer.from(secret.slice('whsec_'.length), 'base64'),
      )
        .update(
          `${String(headers['webhook-id'])}.${String(headers['webhook-timestamp'])}.${raw}`,
        )
        .digest('base64');
      expect(String(headers['webhook-signature']).split(' ')).toContain(
        `v1,${expected}`,
      );

      // The relay again (a redelivery) sends nothing more.
      await deliverWebhooks(app);
      expect(
        receiver.received.filter((w) => w.body.data.id === id),
      ).toHaveLength(1);
    } finally {
      await receiver.close();
    }
  });

  it("deletes a deleted client's endpoints, and keeps a deactivated one's", async () => {
    const tenancy = app.get(Tenancy);
    const endpoints = app.get(WebhookEndpoints);
    const [gone, paused] = await tenancy.run(tenantId, () =>
      db()
        .insert(apiClients)
        .values([
          { name: `gone-${randomUUID()}` },
          { name: `paused-${randomUUID()}` },
        ])
        .returning(),
    );
    for (const owner of [gone!, paused!]) {
      await endpoints.create({
        url: 'https://hooks.example.com/x',
        eventTypes: ['*'],
        tenant: owner.id,
      });
    }
    await tenancy.run(tenantId, async () => {
      await db().delete(apiClients).where(eq(apiClients.id, gone!.id));
      await db()
        .update(apiClients)
        .set({ active: false })
        .where(eq(apiClients.id, paused!.id));
      for (const owner of [gone!, paused!]) {
        await app.get(EventEmitter2).emitAsync(API_CLIENT_EVENTS.revoked, {
          clientId: owner.id,
          tenantId,
        });
      }
    });
    expect(await endpoints.list({ tenant: gone!.id })).toEqual([]);
    expect(await endpoints.list({ tenant: paused!.id })).toHaveLength(1);
  });

  it('prunes finished deliveries past WEBHOOKS_DELIVERY_RETENTION_DAYS with their recorded requests, and keeps recent and pending ones', async () => {
    const receiver = await webhookReceiver();
    try {
      const owner = await client();
      const endpoint = await call(
        'POST',
        '/v1/webhook-endpoints',
        owner.headers,
        { url: receiver.url, eventTypes: ['*'] },
      );
      const send = async () =>
        (
          await call(
            'POST',
            `/v1/webhook-endpoints/${endpoint.json().id}/test`,
            owner.headers,
          )
        ).json().id as string;
      const old = await send();
      const recent = await send();
      await deliverWebhooks(app);
      const [oldFailed, retrying] = [await send(), await send()];

      const now = Date.now();
      const finish = (id: string, status: string, completedAt: number) =>
        db()
          .update(storeDeliveries)
          .set({ status, completedAt })
          .where(eq(storeDeliveries.id, id));
      await finish(old, 'succeeded', now - 31 * DAY);
      await finish(recent, 'succeeded', now - 29 * DAY);
      await finish(oldFailed, 'failed', now - 40 * DAY);
      // Still pending, however long ago it was created.
      await db()
        .update(storeDeliveries)
        .set({ createdAt: now - 60 * DAY })
        .where(eq(storeDeliveries.id, retrying));
      const orphan = `dlv_${randomUUID().replaceAll('-', '')}`;
      await db()
        .insert(webhookDeliveryRequests)
        .values(
          [oldFailed, retrying, orphan].map((deliveryId) => ({
            deliveryId,
            attempt: 1,
            headers: { 'webhook-id': 'msg_1' },
          })),
        );
      const ids = [old, recent, oldFailed, retrying, orphan];
      const requests = async () =>
        (
          await db()
            .select({ id: webhookDeliveryRequests.deliveryId })
            .from(webhookDeliveryRequests)
            .where(inArray(webhookDeliveryRequests.deliveryId, ids))
        )
          .map((row) => row.id)
          .sort();

      const result = await app.get(WebhookDeliveryRetentionJob).run();
      expect(result.deliveries).toBeGreaterThanOrEqual(2);
      const kept = await db()
        .select({ id: storeDeliveries.id })
        .from(storeDeliveries)
        .where(and(inArray(storeDeliveries.id, ids)));
      expect(kept.map((row) => row.id).sort()).toEqual(
        [recent, retrying].sort(),
      );
      expect(await requests()).toEqual([recent, retrying].sort());
      expect(
        (await call('GET', `/v1/webhook-deliveries/${old}`, owner.headers))
          .statusCode,
      ).toBe(404);
      expect(
        (await call('GET', `/v1/webhook-deliveries/${recent}`, owner.headers))
          .statusCode,
      ).toBe(200);
      expect(await app.get(WebhookDeliveryRetentionJob).run()).toEqual({
        deliveries: 0,
        requests: 0,
      });
    } finally {
      await receiver.close();
    }
  });
});
