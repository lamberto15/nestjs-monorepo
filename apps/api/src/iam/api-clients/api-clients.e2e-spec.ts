import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { getDrizzleToken } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  roleIds,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../audit/audit.tables.js';
import { apiKeys } from '../auth/auth.tables.js';
import { ClientOnly } from '../auth/client-only.decorator.js';
import type { Principal } from '../auth/principal.js';
import { API_CLIENT_EVENTS } from './api-clients.events.js';
import { ApiClientsModule } from './api-clients.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-api-clients-${process.pid}-${Date.now()}`;
});

/** A route a key can reach, to see whether it still works. */
@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  @Get('client')
  @ClientOnly()
  client(@CurrentUser() client: Principal) {
    return { id: client.kind === 'client' ? client.id : null };
  }
}

type Headers = Record<string, string>;
const URL = '/v1/access/clients';

describe('API clients (e2e)', () => {
  let app: NestNodeApplication;
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());
  const probe = (key: string) =>
    app.inject({
      method: 'GET',
      url: '/probe/client',
      headers: { authorization: `Bearer ${key}` },
    });
  const audit = (tenantId: string) =>
    app.get(Tenancy).run(tenantId, () => db().select().from(auditLog));
  const heard: Record<string, unknown[]> = {};

  beforeAll(async () => {
    app = await bootModules(...accessModules(), ApiClientsModule, {
      module: class ProbeModule {},
      controllers: [ProbeController],
    } as never);
    const events = app.get(EventEmitter2);
    for (const name of Object.values(API_CLIENT_EVENTS)) {
      events.on(name, (payload: unknown) => (heard[name] ??= []).push(payload));
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    for (const name of Object.keys(heard)) delete heard[name];
  });

  /** A client made through the API: its id, key and the admin who made it. */
  async function made(body: object = {}) {
    const { tenantId, admin } = await tenantWithAdmin(app);
    const created = await call('POST', URL, admin.headers, {
      name: 'billing',
      ...body,
    });
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json();
    return { tenantId, admin, id: id as string, key: key as string };
  }

  it('creates a client whose key is shown once, never again, and works', async () => {
    const { tenantId, admin, id, key } = await made();
    expect(key).toMatch(/^sk_[0-9a-f]{16}_/);
    expect((await probe(key)).json()).toEqual({ id });

    const read = (await call('GET', `${URL}/${id}`, admin.headers)).json();
    expect(read.keys).toHaveLength(1);
    expect(JSON.stringify(read)).not.toContain(key.split('_')[2]);
    expect(JSON.stringify(read)).not.toContain('keyHash');
    const list = (await call('GET', URL, admin.headers)).json();
    expect(list.items.map((client: { id: string }) => client.id)).toEqual([id]);

    const duplicate = await call('POST', URL, admin.headers, {
      name: 'billing',
    });
    expect(duplicate.statusCode).toBe(409);

    const actions = (await audit(tenantId)).map((row) => row.action);
    expect(actions).toContain('client.created');
  });

  it('refuses a key that ends in the past', async () => {
    const { tenantId, admin } = await tenantWithAdmin(app);
    void tenantId;
    const response = await call('POST', URL, admin.headers, {
      name: 'late',
      keyExpiresAt: '2020-01-01T00:00:00Z',
    });
    expect(response.statusCode).toBe(400);
  });

  it('rotates: the old key stops at once, or after a grace period', async () => {
    const { admin, id, key } = await made();
    const graceful = await call('POST', `${URL}/${id}/rotate`, admin.headers, {
      graceSeconds: 3600,
    });
    expect(graceful.statusCode).toBe(200);
    const second = graceful.json().key as string;
    expect((await probe(key)).statusCode).toBe(200);
    expect((await probe(second)).statusCode).toBe(200);
    expect(heard[API_CLIENT_EVENTS.keysRevoked]).toBeUndefined();

    const now = await call('POST', `${URL}/${id}/rotate`, admin.headers);
    const third = now.json().key as string;
    expect((await probe(key)).statusCode).toBe(401);
    expect((await probe(second)).statusCode).toBe(401);
    expect((await probe(third)).statusCode).toBe(200);
    const [event] = heard[API_CLIENT_EVENTS.keysRevoked] as {
      keyIds: string[];
    }[];
    expect(event!.keyIds).toHaveLength(2);
    expect(event!.keyIds).toContain(key.split('_')[1]);
  });

  it('revokes one key', async () => {
    const { admin, id, key } = await made();
    const [row] = await app.get(Tenancy).run(null, () =>
      db()
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyId, key.split('_')[1]!)),
    );
    const revoked = await call(
      'DELETE',
      `${URL}/${id}/keys/${row!.id}`,
      admin.headers,
    );
    expect(revoked.statusCode).toBe(204);
    expect((await probe(key)).statusCode).toBe(401);
    expect(heard[API_CLIENT_EVENTS.keysRevoked]).toEqual([
      { keyIds: [key.split('_')[1]] },
    ]);
    // Twice: nothing left to revoke.
    expect(
      (await call('DELETE', `${URL}/${id}/keys/${row!.id}`, admin.headers))
        .statusCode,
    ).toBe(404);
  });

  it('revokes and reactivates a client, and keeps an address allowlist', async () => {
    const { tenantId, admin, id, key } = await made();
    await call('PATCH', `${URL}/${id}`, admin.headers, { active: false });
    expect((await probe(key)).statusCode).toBe(401);
    expect(heard[API_CLIENT_EVENTS.revoked]).toEqual([
      { clientId: id, tenantId },
    ]);
    await call('PATCH', `${URL}/${id}`, admin.headers, { active: true });
    expect((await probe(key)).statusCode).toBe(200);

    const bad = await call('PATCH', `${URL}/${id}`, admin.headers, {
      allowedCidrs: ['not-an-address'],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_cidr');
    const set = await call('PATCH', `${URL}/${id}`, admin.headers, {
      allowedCidrs: ['10.0.0.1'],
    });
    expect(set.json().allowedCidrs).toEqual(['10.0.0.1/32']);
    expect((await probe(key)).statusCode).toBe(403);
    await call('PATCH', `${URL}/${id}`, admin.headers, { allowedCidrs: [] });
    expect((await probe(key)).statusCode).toBe(200);

    const actions = (await audit(tenantId)).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'client.revoked',
        'client.activated',
        'client.allowlist-changed',
      ]),
    );
  });

  it('gives a client roles, with an end, and replaces them', async () => {
    const { tenantId, admin, id } = await made();
    const [editor] = await roleIds(app, tenantId, 'editor');
    const end = new Date(Date.now() + 86_400_000).toISOString();
    const changed = await call('PATCH', `${URL}/${id}`, admin.headers, {
      roleIds: [editor],
      roleExpiresAt: { [editor!]: end },
    });
    expect(changed.json().roles).toEqual([{ roleId: editor, expiresAt: end }]);
    const unknown = await call('PATCH', `${URL}/${id}`, admin.headers, {
      roleIds: ['018f0000-0000-7000-8000-000000000000'],
    });
    expect(unknown.statusCode).toBe(400);
    const cleared = await call('PATCH', `${URL}/${id}`, admin.headers, {
      roleIds: [],
    });
    expect(cleared.json().roles).toEqual([]);
  });

  it('deletes a client for good: its keys stop, and it is gone', async () => {
    const { tenantId, admin, id, key } = await made();
    expect(
      (await call('DELETE', `${URL}/${id}`, admin.headers)).statusCode,
    ).toBe(204);
    expect((await probe(key)).statusCode).toBe(401);
    expect((await call('GET', `${URL}/${id}`, admin.headers)).statusCode).toBe(
      404,
    );
    expect(heard[API_CLIENT_EVENTS.revoked]).toEqual([
      { clientId: id, tenantId },
    ]);
    const deleted = (await audit(tenantId)).find(
      (row) => row.action === 'client.deleted' && row.targetId === id,
    );
    expect(deleted?.details).toMatchObject({ name: 'billing' });
  });

  it("is the tenant's own: another tenant's administrator finds nothing", async () => {
    const { id } = await made();
    const other = await tenantWithAdmin(app);
    expect(
      (await call('GET', `${URL}/${id}`, other.admin.headers)).statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `${URL}/${id}`, other.admin.headers)).statusCode,
    ).toBe(404);
  });

  it('is managed only by whoever may, and never above their own authority', async () => {
    const { tenantId, admin, id } = await made();
    const viewer = await member(app, tenantId, ['viewer']);
    expect((await call('GET', URL, viewer.headers)).statusCode).toBe(403);
    expect(
      (await call('POST', URL, viewer.headers, { name: 'x' })).statusCode,
    ).toBe(403);

    const role = await call('POST', '/v1/access/roles', admin.headers, {
      name: 'Client manager',
      permissions: [
        { subject: 'Access', action: 'manageClients', conditions: [] },
      ],
    });
    const manager = await member(app, tenantId, [role.json().id]);
    expect((await call('GET', URL, manager.headers)).statusCode).toBe(200);
    expect(
      (await call('POST', URL, manager.headers, { name: 'ok' })).statusCode,
    ).toBe(201);

    // A client holding the administrator role can't be touched by a manager.
    const [administrator] = await roleIds(app, tenantId, 'administrator');
    await call('PATCH', `${URL}/${id}`, admin.headers, {
      roleIds: [administrator],
    });
    const refused = await call('DELETE', `${URL}/${id}`, manager.headers);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('authority_required');
    expect(
      (
        await call('POST', URL, manager.headers, {
          name: 'sneaky',
          roleIds: [administrator],
        })
      ).statusCode,
    ).toBe(403);
  });
});
