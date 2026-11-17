import { randomUUID } from 'node:crypto';
import { Controller, Get, Module } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  accessModules,
  member,
  roleIds,
  seededAdmin,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { REDIS } from '../../core/redis/redis.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { RequireFlag } from './flag.guard.js';
import { rolloutBucket } from './settings.resolution.js';
import { SettingsModule } from './settings.module.js';
import { SettingsService } from './settings.service.js';
import { settingOverrides } from './settings.tables.js';
import { defineSettings, flag, setting } from './settings.types.js';
import type { Redis } from 'ioredis';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-settings-${process.pid}-${Date.now()}`;
  process.env.OPERATOR_TENANT = 'ops';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
  process.env.DATA_ENCRYPTION_KEYS = Buffer.alloc(32, 7).toString('base64');
});

/** A module declares its settings and flags as a real one does. */
const DELAY = setting({
  key: 'testSettings.delay',
  label: 'Delay',
  schema: z.int().min(1).max(60),
  default: 10,
  scopes: ['tenant', 'unit', 'user'],
});
const BETA = flag({ key: 'testSettings.beta', label: 'Beta', default: false });
const LIMIT = setting({
  key: 'testSettings.limit',
  label: 'Limit',
  schema: z.int(),
  default: 5,
  public: false,
});
const TOKEN = setting({
  key: 'testSettings.token',
  label: 'Token',
  schema: z.string().max(200),
  default: '',
  secret: true,
});
const OPERATORS_ONLY = setting({
  key: 'testSettings.operatorsOnly',
  label: 'Operators only',
  schema: z.enum(['a', 'b']),
  default: 'a',
  scopes: [],
});
const TEST_SETTINGS = defineSettings([
  DELAY,
  BETA,
  LIMIT,
  TOKEN,
  OPERATORS_ONLY,
]);

@Controller('test-settings')
class BetaController {
  @Get('beta')
  @Can.Anyone()
  @RequireFlag(BETA)
  beta() {
    return { beta: true };
  }
}

@Module({
  imports: [SettingsModule.forFeature(TEST_SETTINGS)],
  controllers: [BetaController],
})
class TestSettingsModule {}

type Headers = Record<string, string>;

describe('settings (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: { id: string; headers: Headers };
  let ops: { tenantId: string; admin: { headers: Headers } };
  const call = (
    method: 'GET' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());
  const settingOf = (body: { items: { key: string }[] }, key: string) =>
    body.items.find((item) => item.key === key);
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);
  const view = async (headers: Headers, key: string) =>
    (await call('GET', `/v1/settings/${key}`, headers)).json();
  const audited = (action: string) =>
    app.get(Tenancy).run(tenantId, () =>
      db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action))),
    );

  beforeAll(async () => {
    app = await bootModules(...accessModules(), TestSettingsModule);
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
    admin = tenant.admin;
    // The seeded tenant is the operators' (OPERATOR_TENANT), with its administrator.
    const seeded = await seededAdmin(app);
    ops = { tenantId: seeded.tenantId, admin: seeded };
  });
  afterAll(async () => {
    await app?.close();
  });

  it('shows the declared settings; what is not public only to those who may read settings', async () => {
    const editor = await member(app, tenantId, ['editor']);
    const shown = (await call('GET', '/v1/settings', editor.headers)).json();
    expect(settingOf(shown, DELAY.key)).toMatchObject({
      value: 10,
      source: 'default',
      default: 10,
      scopes: ['tenant', 'unit', 'user'],
      flag: false,
      type: 'number',
      integer: true,
      min: 1,
      max: 60,
      canEdit: false,
      canSetMine: true,
    });
    expect(settingOf(shown, BETA.key)).toMatchObject({
      flag: true,
      value: false,
    });
    expect(settingOf(shown, LIMIT.key)).toBeUndefined();
    expect(
      (await call('GET', `/v1/settings/${LIMIT.key}`, editor.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', '/v1/settings/testSettings.nope', editor.headers))
        .statusCode,
    ).toBe(404);
    const all = (await call('GET', '/v1/settings', admin.headers)).json();
    expect(settingOf(all, LIMIT.key)).toMatchObject({
      public: false,
      canEdit: true,
      canEditPlatform: false,
    });
  });

  it('lets only those who may update set values; what is sent is checked; every change is audited', async () => {
    const editor = await member(app, tenantId, ['editor']);
    const url = `/v1/settings/${DELAY.key}`;
    expect(
      (await call('PUT', url, editor.headers, { value: 20 })).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `${url}/overrides`, editor.headers)).statusCode,
    ).toBe(403);
    const bad = await call('PUT', url, admin.headers, { value: 'soon' });
    expect(bad.statusCode).toBe(400);
    expect(paths(bad.json())).toEqual(['value']);
    expect(
      (
        await call('PUT', '/v1/settings/testSettings.nope', admin.headers, {
          value: 1,
        })
      ).statusCode,
    ).toBe(404);
    const scope = await call(
      'PUT',
      `/v1/settings/${OPERATORS_ONLY.key}`,
      admin.headers,
      { value: 'b' },
    );
    expect(paths(scope.json())).toEqual(['scope']);
    const rollout = await call('PUT', url, admin.headers, {
      value: 20,
      rollout: 10,
    });
    expect(paths(rollout.json())).toEqual(['rollout']);

    const set = await call('PUT', url, admin.headers, { value: 20 });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      key: DELAY.key,
      scope: 'tenant',
      scopeId: '',
      value: 20,
      rollout: null,
      updatedBy: `user:${admin.id}`,
    });
    expect(await view(editor.headers, DELAY.key)).toMatchObject({
      value: 20,
      source: 'tenant',
    });
    const overrides = (
      await call('GET', `${url}/overrides`, admin.headers)
    ).json();
    expect(overrides.items).toHaveLength(1);
    expect((await call('DELETE', url, admin.headers)).statusCode).toBe(204);
    expect(await view(editor.headers, DELAY.key)).toMatchObject({
      value: 10,
      source: 'default',
    });

    const updated = await audited('setting.updated');
    expect(
      updated.some(
        (e) => e.targetId === DELAY.key && (e.details as any).to.value === 20,
      ),
    ).toBe(true);
    expect(
      (await audited('setting.reset')).some((e) => e.targetId === DELAY.key),
    ).toBe(true);
  });

  it("applies a unit's value to its members, a person's own value over it, and their own preference", async () => {
    const [inUnit, other] = [
      await member(app, tenantId, ['editor']),
      await member(app, tenantId, ['editor']),
    ];
    const unit = (
      await call(
        'POST' as never,
        '/v1/access/organizational-units',
        admin.headers,
        { type: 'team', name: 'Unit A' },
      )
    ).json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/v1/access/organizational-units/${unit.id}/members`,
      headers: admin.headers,
      payload: { userId: inUnit.id },
    });
    const url = `/v1/settings/${DELAY.key}`;
    await call('PUT', url, admin.headers, { value: 30 });
    await call('PUT', url, admin.headers, {
      scope: 'unit',
      scopeId: unit.id,
      value: 40,
    });
    expect(await view(inUnit.headers, DELAY.key)).toMatchObject({
      value: 40,
      source: 'unit',
    });
    expect(await view(other.headers, DELAY.key)).toMatchObject({
      value: 30,
      source: 'tenant',
    });
    expect(
      (
        await call('PUT', url, admin.headers, {
          scope: 'unit',
          scopeId: randomUUID(),
          value: 40,
        })
      ).statusCode,
    ).toBe(404);

    // Their own preference beats the unit's; dropping it goes back.
    const mine = await call('PUT', `${url}/mine`, inUnit.headers, { value: 5 });
    expect(mine.json()).toMatchObject({ value: 5, source: 'user' });
    expect(
      paths(
        (
          await call('PUT', `${url}/mine`, inUnit.headers, { value: 'x' })
        ).json(),
      ),
    ).toEqual(['value']);
    expect(
      (
        await call('PUT', `/v1/settings/${LIMIT.key}/mine`, inUnit.headers, {
          value: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('DELETE', `${url}/mine`, inUnit.headers)).json(),
    ).toMatchObject({ value: 40, source: 'unit' });

    // An administrator sets one person's value, who must be a member.
    await call('PUT', url, admin.headers, {
      scope: 'user',
      scopeId: `user:${other.id}`,
      value: 7,
    });
    expect(await view(other.headers, DELAY.key)).toMatchObject({
      value: 7,
      source: 'user',
    });
    expect(
      (
        await call('PUT', url, admin.headers, {
          scope: 'user',
          scopeId: `user:${randomUUID()}`,
          value: 7,
        })
      ).statusCode,
    ).toBe(404);
    await call(
      'DELETE',
      `${url}?scope=user&scopeId=user:${other.id}`,
      admin.headers,
    );
    await call('DELETE', `${url}?scope=unit&scopeId=${unit.id}`, admin.headers);
    await call('DELETE', url, admin.headers);
  });

  it('rolls a flag out to a stable share, switches it by rule, and closes a route while it is off', async () => {
    const editor = await member(app, tenantId, ['editor']);
    const beta = `/v1/settings/${BETA.key}`;
    const route = '/v1/test-settings/beta';
    expect((await call('GET', route, editor.headers)).statusCode).toBe(404);

    await call('PUT', beta, admin.headers, { rollout: 100 });
    expect(await view(editor.headers, BETA.key)).toMatchObject({
      value: true,
      source: 'rollout',
    });
    expect((await call('GET', route, editor.headers)).statusCode).toBe(200);
    await call('PUT', beta, admin.headers, { rollout: 50 });
    const bucket = rolloutBucket(BETA.key, tenantId, `user:${editor.id}`);
    expect((await view(editor.headers, BETA.key)).value).toBe(bucket < 50);

    // Rules first: the editors role is off, the verified domain on; failing closed otherwise.
    const [editorRole] = await roleIds(app, tenantId, 'editor');
    const rules = [
      {
        conditions: [{ key: 'role', params: { roleIds: [editorRole] } }],
        outcome: { value: false },
      },
      {
        conditions: [{ key: 'principalKind', params: { kinds: ['user'] } }],
        outcome: { value: true },
      },
    ];
    const bad = await call('PUT', beta, admin.headers, {
      value: false,
      rules: [
        {
          conditions: [{ key: 'role', params: { roleIds: [randomUUID()] } }],
          outcome: { value: true },
        },
      ],
    });
    expect(paths(bad.json())).toEqual(['rules']);
    const set = await call('PUT', beta, admin.headers, { value: false, rules });
    expect(set.statusCode).toBe(200);
    expect(await view(editor.headers, BETA.key)).toMatchObject({
      value: false,
      source: 'rule',
    });
    expect(await view(admin.headers, BETA.key)).toMatchObject({
      value: true,
      source: 'rule',
    });
    expect((await call('GET', route, admin.headers)).statusCode).toBe(200);
    expect((await call('GET', route, editor.headers)).statusCode).toBe(404);
    expect(
      (await call('PUT', beta, admin.headers, { value: true, rules: [] }))
        .statusCode,
    ).toBe(200);
    expect(await view(editor.headers, BETA.key)).toMatchObject({
      value: true,
      source: 'tenant',
    });
    await call('DELETE', beta, admin.headers);
  });

  it("lets operators set a value for every tenant, below the tenants' own or above them all", async () => {
    const editor = await member(app, tenantId, ['editor']);
    const url = `/v1/settings/${DELAY.key}/platform`;
    const denied = await call('PUT', url, admin.headers, { value: 50 });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('operator_required');
    expect(
      (await call('PUT', url, editor.headers, { value: 50 })).statusCode,
    ).toBe(403);

    const operators = ops.admin.headers;
    expect(
      (await call('PUT', url, operators, { value: 'soon' })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', url, operators, { value: 50, rollout: 10 }))
        .statusCode,
    ).toBe(400);
    expect((await call('PUT', url, operators, { value: 50 })).statusCode).toBe(
      200,
    );
    expect(await view(editor.headers, DELAY.key)).toMatchObject({
      value: 50,
      source: 'platform',
      platform: { value: 50, enforced: false },
    });
    expect(await view(operators, DELAY.key)).toMatchObject({
      canEditPlatform: true,
    });

    // A tenant's own value beats it; enforced, it beats the tenant's.
    await call('PUT', `/v1/settings/${DELAY.key}`, admin.headers, {
      value: 20,
    });
    expect(await view(editor.headers, DELAY.key)).toMatchObject({
      value: 20,
      source: 'tenant',
    });
    await call('PUT', url, operators, { value: 55, enforced: true });
    expect(await view(editor.headers, DELAY.key)).toMatchObject({
      value: 55,
      source: 'platform',
    });
    expect(
      (await call('PUT', url, operators, { enforced: true, rollout: 10 }))
        .statusCode,
    ).toBe(400);

    // Removed, the tenant's value holds again.
    expect((await call('DELETE', url, operators)).statusCode).toBe(204);
    expect(await view(editor.headers, DELAY.key)).toMatchObject({
      value: 20,
      source: 'tenant',
    });
    await call('DELETE', `/v1/settings/${DELAY.key}`, admin.headers);

    // A platform-only setting (no tenant scope), and the audit in the operators' tenant.
    await call(
      'PUT',
      `/v1/settings/${OPERATORS_ONLY.key}/platform`,
      operators,
      { value: 'b' },
    );
    expect(await view(editor.headers, OPERATORS_ONLY.key)).toMatchObject({
      value: 'b',
      source: 'platform',
    });
    await call(
      'DELETE',
      `/v1/settings/${OPERATORS_ONLY.key}/platform`,
      operators,
    );
    const entries = await app
      .get(Tenancy)
      .run(ops.tenantId, () =>
        db()
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, 'setting.updated')),
      );
    expect(entries.some((e) => (e.details as any).scope === 'platform')).toBe(
      true,
    );
  });

  it('keeps a secret setting encrypted, out of the API and the audit log', async () => {
    const url = `/v1/settings/${TOKEN.key}`;
    const set = await call('PUT', url, admin.headers, {
      value: 'hunter2-token',
    });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain('hunter2');
    const shown = await view(admin.headers, TOKEN.key);
    expect(shown).toMatchObject({
      secret: true,
      value: null,
      source: 'tenant',
    });
    expect(JSON.stringify(shown)).not.toContain('hunter2');
    expect(
      (await call('GET', `${url}/overrides`, admin.headers)).body,
    ).not.toContain('hunter2');

    const [row] = await app
      .get(Tenancy)
      .run(tenantId, () =>
        db()
          .select()
          .from(settingOverrides)
          .where(eq(settingOverrides.key, TOKEN.key)),
      );
    expect(row!.value).toBeNull();
    expect(row!.secret).not.toContain('hunter2');
    const read = await app
      .get(Tenancy)
      .run(tenantId, () => app.get(SettingsService).get(TOKEN));
    expect(read).toBe('hunter2-token');
    const entries = await audited('setting.updated');
    expect(JSON.stringify(entries)).not.toContain('hunter2');
    await call('DELETE', url, admin.headers);
  });

  it("forgets a tenant's values when another instance announces a change", async () => {
    const settings = app.get(SettingsService);
    const read = () =>
      app.get(Tenancy).run(tenantId, () => settings.get(DELAY));
    expect(await read()).toBe(10);
    // A change made behind this instance's back: it serves what it has.
    await app.get(Tenancy).run(tenantId, () =>
      db().insert(settingOverrides).values({
        key: DELAY.key,
        scope: 'tenant',
        scopeId: '',
        value: 33,
        updatedBy: 'user:elsewhere',
      }),
    );
    expect(await read()).toBe(10);
    const redis = app.get<Redis>(REDIS);
    await redis.publish(
      `${redis.options.keyPrefix}settings:invalidate`,
      `another-instance ${tenantId}`,
    );
    await vi.waitFor(async () => expect(await read()).toBe(33));
    await app
      .get(Tenancy)
      .run(tenantId, () =>
        db()
          .delete(settingOverrides)
          .where(eq(settingOverrides.key, DELAY.key)),
      );
  });
});
