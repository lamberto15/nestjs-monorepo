import { randomUUID } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { signWebhook } from '@nestjs/webhooks/testing';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { member, tenantWithAdmin } from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { webhookModules } from '../../../test/webhooks.js';
import type { Database } from '../../core/database/database.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import {
  type IncomingEventContext,
  OnIncomingWebhook,
} from './incoming-events.js';
import { incomingWebhookSenders } from './webhooks.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.OUTBOX_RELAY = 'off';
  process.env.WEBHOOKS_WORKER = 'off';
  process.env.DATA_ENCRYPTION_KEYS =
    'ZmFrZS10ZXN0LWtleS1mb3Itd2ViaG9va3MtZTJlLTAx';
  process.env.REDIS_PREFIX = `test-senders-${process.pid}-${Date.now()}`;
});

/** What the handler of `test.echo` saw, in order. */
const seen: { tenantId: string; scope: string; sender: string; id: string }[] =
  [];

// The example receiver: a module's handler of an incoming event type.
@Injectable()
class EchoReceiver {
  constructor(private readonly tenancy: Tenancy) {}

  @OnIncomingWebhook({
    type: 'test.echo',
    description: 'Echo.',
    data: z.object({ n: z.number() }),
    example: { n: 1 },
    delivery: 'Deduplicated by the webhook-id.',
  })
  echo(ctx: IncomingEventContext) {
    seen.push({
      tenantId: ctx.tenantId,
      // The tenant the work really runs in: the request's scope.
      scope: this.tenancy.tenantId(),
      sender: ctx.sender,
      id: ctx.webhook.id,
    });
    return Promise.resolve({ duplicate: false });
  }
}

@Module({ providers: [EchoReceiver] })
class EchoModule {}

type Headers = Record<string, string>;
interface Sender {
  id: string;
  secret: string;
  path: string;
  name: string;
}

describe('incoming webhook senders of a tenant (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Headers;
  let other: { tenantId: string; admin: { headers: Headers } };
  const db = () => app.get<Database>(getDrizzleToken());
  const req = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers = {},
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  beforeAll(async () => {
    app = await bootModules(...webhookModules(), EchoModule);
  });
  beforeEach(async () => {
    // A fresh pair of tenants per test: sender names stay free.
    ({
      tenantId,
      admin: { headers: admin },
    } = await tenantWithAdmin(app));
    other = await tenantWithAdmin(app);
    seen.length = 0;
  });
  afterAll(async () => {
    await app?.close();
  });

  async function create(headers: Headers = admin, name = 'crm') {
    const res = await req('POST', '/v1/webhook-senders', headers, { name });
    expect(res.statusCode).toBe(201);
    return res.json<Sender>();
  }

  /** A call to `path`, signed with `secret`. */
  function call(
    path: string,
    secret: string,
    {
      id = `msg_${randomUUID()}`,
      payload = { type: 'test.echo', data: { n: 1 } } as unknown,
      timestamp,
      tamper = false,
    }: {
      id?: string;
      payload?: unknown;
      timestamp?: Date;
      tamper?: boolean;
    } = {},
  ) {
    const signed = signWebhook({
      scheme: 'standard',
      secret,
      payload,
      id,
      timestamp,
    });
    return app.inject({
      method: 'POST',
      url: path,
      headers: { ...signed.headers, 'content-type': 'application/json' },
      payload: tamper ? signed.body.replace('"n":1', '"n":2') : signed.body,
    });
  }
  const status = async (res: ReturnType<typeof call>) => (await res).statusCode;

  it('verifies a call with the sender’s secret and runs it in the sender’s tenant', async () => {
    const sender = await create();
    expect(sender.secret).toMatch(/^whsec_/);
    expect(sender.path).toBe(`/v1/webhooks/tenants/${tenantId}/senders/crm`);

    const id = `msg_${randomUUID()}`;
    const first = await call(sender.path, sender.secret, { id });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      received: true,
      duplicate: false,
      handled: true,
    });
    expect(seen).toEqual([
      { tenantId, scope: tenantId, sender: 'crm', id: `${sender.id}:${id}` },
    ]);

    // The sender's retry of the same event id: answered without running the handler.
    expect(await status(call(sender.path, sender.secret, { id }))).toBe(200);
    expect(seen).toHaveLength(1);

    // An event nobody handles is acknowledged, not retried.
    const ignored = await call(sender.path, sender.secret, {
      payload: { type: 'nobody.handles', data: {} },
    });
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json()).toMatchObject({ received: true, handled: false });
    // A `data` that does not match the type's schema is a 400, before the handler.
    const invalid = await call(sender.path, sender.secret, {
      payload: { type: 'test.echo', data: { n: 'x' } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().errors[0].path).toBe('data.n');
    expect(seen).toHaveLength(1);
    // A body that is not an event is a 400, signed or not.
    expect(
      await status(call(sender.path, sender.secret, { payload: { data: 1 } })),
    ).toBe(400);
  });

  it('refuses another tenant’s secret, and a sender under another tenant’s URL', async () => {
    const mine = await create();
    const theirs = await create(other.admin.headers);
    expect(theirs.path).toBe(
      `/v1/webhooks/tenants/${other.tenantId}/senders/crm`,
    );
    expect(theirs.secret).not.toBe(mine.secret);

    expect(await status(call(mine.path, theirs.secret))).toBe(401);
    expect(await status(call(theirs.path, mine.secret))).toBe(401);
    const only = await create(other.admin.headers, 'only-theirs');
    for (const path of [
      `/v1/webhooks/tenants/${tenantId}/senders/only-theirs`,
      `/v1/webhooks/tenants/${randomUUID()}/senders/crm`,
      '/v1/webhooks/tenants/not-a-uuid/senders/crm',
      `/v1/webhooks/tenants/${tenantId}/senders/nope`,
    ]) {
      expect({ path, status: await status(call(path, only.secret)) }).toEqual({
        path,
        status: 401,
      });
      expect({ path, status: await status(call(path, mine.secret)) }).toEqual({
        path,
        status: 401,
      });
    }
    expect(seen).toEqual([]);

    expect(await status(call(mine.path, mine.secret))).toBe(200);
    expect(await status(call(theirs.path, theirs.secret))).toBe(200);
    expect(seen.map((s) => [s.tenantId, s.scope])).toEqual([
      [tenantId, tenantId],
      [other.tenantId, other.tenantId],
    ]);
  });

  it('refuses a bad, tampered or stale signature, and no signature', async () => {
    const sender = await create();
    const wrong = `whsec_${Buffer.from(randomUUID()).toString('base64')}`;
    expect(await status(call(sender.path, wrong))).toBe(401);
    expect(
      await status(
        call(sender.path, sender.secret, {
          timestamp: new Date(Date.now() - 3600_000),
        }),
      ),
    ).toBe(401);
    expect(
      await status(call(sender.path, sender.secret, { tamper: true })),
    ).toBe(401);
    const unsigned = await req(
      'POST',
      sender.path,
      {},
      { type: 'test.echo', data: { n: 1 } },
    );
    expect(unsigned.statusCode).toBe(401);
    expect(seen).toEqual([]);
  });

  it('gives two senders of two tenants the same webhook id without one blocking the other', async () => {
    const [mine, theirs] = [await create(), await create(other.admin.headers)];
    const id = `msg_${randomUUID()}`;
    expect(await status(call(mine.path, mine.secret, { id }))).toBe(200);
    expect(await status(call(theirs.path, theirs.secret, { id }))).toBe(200);
    expect(seen).toHaveLength(2);
  });

  it('stops a disabled or removed sender, and keeps the old secret only for the grace period', async () => {
    const sender = await create();
    const url = `/v1/webhook-senders/${sender.id}`;
    expect(
      (await req('PATCH', url, admin, { enabled: false })).statusCode,
    ).toBe(200);
    expect(await status(call(sender.path, sender.secret))).toBe(401);
    expect(
      (
        await req('PATCH', url, admin, {
          enabled: true,
          description: 'The CRM',
        })
      ).statusCode,
    ).toBe(200);
    expect(await status(call(sender.path, sender.secret))).toBe(200);

    const rotated = await req('POST', `${url}/rotate-secret`, admin, {});
    expect(rotated.statusCode).toBe(200);
    const { secret, previousSecretExpiresAt } = rotated.json<{
      secret: string;
      previousSecretExpiresAt: string;
    }>();
    expect(secret).not.toBe(sender.secret);
    expect(new Date(previousSecretExpiresAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(await status(call(sender.path, secret))).toBe(200);
    expect(await status(call(sender.path, sender.secret))).toBe(200); // within the grace period

    const ended = await req('POST', `${url}/rotate-secret`, admin, {
      graceSeconds: 0,
    });
    expect(ended.json().previousSecretExpiresAt).toBeNull();
    expect(await status(call(sender.path, secret))).toBe(401);
    expect(
      await status(call(sender.path, ended.json<{ secret: string }>().secret)),
    ).toBe(200);

    expect((await req('DELETE', url, admin)).statusCode).toBe(204);
    expect(
      await status(call(sender.path, ended.json<{ secret: string }>().secret)),
    ).toBe(401);
    expect((await req('DELETE', url, admin)).statusCode).toBe(404);
  });

  it('refuses a call for a deactivated tenant', async () => {
    const theirs = await create(other.admin.headers);
    expect(await status(call(theirs.path, theirs.secret))).toBe(200);
    await db()
      .update(tenants)
      .set({ active: false })
      .where(eq(tenants.id, other.tenantId));
    expect(await status(call(theirs.path, theirs.secret))).toBe(401);
  });

  it('manages senders per tenant, for administrators only, and never shows or audits a secret', async () => {
    const sender = await create();
    await create(admin, 'billing');
    const theirs = await create(other.admin.headers);

    const editor = await member(app, tenantId, ['editor']);
    expect(
      (await req('GET', '/v1/webhook-senders', editor.headers)).statusCode,
    ).toBe(403);
    expect(
      (await req('POST', '/v1/webhook-senders', editor.headers, { name: 'x' }))
        .statusCode,
    ).toBe(403);
    expect((await req('GET', '/v1/webhook-senders')).statusCode).toBe(401);
    const client = await apiClient(app, tenantId);
    expect(
      (await req('GET', '/v1/webhook-senders', client.headers)).statusCode,
    ).toBe(401);

    const list = await req('GET', '/v1/webhook-senders', admin);
    expect(list.json().items.map((s: { name: string }) => s.name)).toEqual([
      'billing',
      'crm',
    ]);
    expect(
      (await req('GET', `/v1/webhook-senders/${theirs.id}`, admin)).statusCode,
    ).toBe(404);
    expect(
      (
        await req('PATCH', `/v1/webhook-senders/${theirs.id}`, admin, {
          enabled: false,
        })
      ).statusCode,
    ).toBe(404);

    expect(
      (await req('POST', '/v1/webhook-senders', admin, { name: 'crm' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await req('POST', '/v1/webhook-senders', admin, { name: 'Not A Name' }))
        .statusCode,
    ).toBe(400);

    const one = await req('GET', `/v1/webhook-senders/${sender.id}`, admin);
    expect(one.statusCode).toBe(200);
    expect(JSON.stringify([list.json(), one.json()])).not.toContain(
      sender.secret,
    );
    expect(one.json()).not.toHaveProperty('secret');

    expect(
      (
        await req(
          'POST',
          `/v1/webhook-senders/${sender.id}/rotate-secret`,
          admin,
          {},
        )
      ).statusCode,
    ).toBe(200);
    const audit = await app
      .get(Tenancy)
      .run(tenantId, () =>
        db().select().from(auditLog).where(eq(auditLog.targetId, sender.id)),
      );
    expect(audit.map((entry) => entry.action).sort()).toEqual([
      'webhookSender.created',
      'webhookSender.secret-rotated',
    ]);
    expect(JSON.stringify(audit)).not.toContain('whsec_');
  });

  it('lists the incoming event types, generated from the handlers, for administrators only', async () => {
    const catalog = await req('GET', '/v1/webhook-incoming-event-types', admin);
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().items).toEqual([
      {
        type: 'test.echo',
        description: 'Echo.',
        dataSchema: expect.objectContaining({ type: 'object' }),
        example: { type: 'test.echo', data: { n: 1 } },
        delivery: 'Deduplicated by the webhook-id.',
      },
    ]);
    const outgoing = await req('GET', '/v1/webhook-event-types', admin);
    expect(JSON.stringify(outgoing.json())).not.toContain('test.echo');

    const editor = await member(app, tenantId, ['editor']);
    expect(
      (await req('GET', '/v1/webhook-incoming-event-types', editor.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (await req('GET', '/v1/webhook-incoming-event-types')).statusCode,
    ).toBe(401);
  });

  it('stores the secret sealed, bound to its sender’s tenant', async () => {
    const sender = await create();
    const [row] = await app
      .get(Tenancy)
      .run(tenantId, () =>
        db()
          .select()
          .from(incomingWebhookSenders)
          .where(eq(incomingWebhookSenders.id, sender.id)),
      );
    expect(row!.secret).not.toContain(sender.secret.slice('whsec_'.length));
    expect(row!.secret).toMatch(/^v1\./);
  });
});
