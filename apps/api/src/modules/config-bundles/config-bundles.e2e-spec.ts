import { Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { z } from 'zod';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { SettingsModule } from '../settings/settings.module.js';
import { defineSettings, flag, setting } from '../settings/settings.types.js';
import { ConfigBundlesModule } from './config-bundles.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-bundles-${process.pid}-${Date.now()}`;
  process.env.OPERATOR_TENANT = 'operators';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
  process.env.DATA_ENCRYPTION_KEYS = Buffer.alloc(32, 7).toString('base64');
});

const DELAY = setting({
  key: 'bundleTest.delay',
  label: 'Delay',
  schema: z.string().max(10),
  default: '10s',
});
const BETA = flag({ key: 'bundleTest.beta', label: 'Beta', default: false });

/** A module that declares settings, as a real one does. */
@Module({
  imports: [SettingsModule.forFeature(defineSettings([DELAY, BETA]))],
})
class DeclaresSettings {}

describe('config bundles (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      DeclaresSettings,
      ConfigBundlesModule,
    );
  });
  afterAll(() => app.close());

  type Headers = Record<string, string>;
  const call = (
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  /** A tenant with a custom role, a value and a flag with a rule naming the role. */
  async function configuredTenant() {
    const t = await tenantWithAdmin(app);
    const role = await call('POST', '/v1/access/roles', t.admin.headers, {
      name: 'Editors',
      description: 'Edit things',
      permissions: [{ subject: 'Setting', action: 'read', conditions: [] }],
    });
    expect(role.statusCode).toBe(201);
    const roleId = role.json().id as string;
    expect(
      (
        await call('PUT', '/v1/settings/bundleTest.delay', t.admin.headers, {
          value: '5m',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call('PUT', '/v1/settings/bundleTest.beta', t.admin.headers, {
          rollout: 20,
          rules: [
            {
              conditions: [{ key: 'role', params: { roleIds: [roleId] } }],
              outcome: { value: true },
            },
          ],
        })
      ).statusCode,
    ).toBe(200);
    return t;
  }

  it('exports by names, never ids, then previews and applies in another tenant', async () => {
    const source = await configuredTenant();
    const exported = await call(
      'GET',
      '/v1/config-bundles/export',
      source.admin.headers,
    );
    expect(exported.statusCode).toBe(200);
    const bundle = exported.json();
    // The seeded roles are editable, so they travel too (the built-in Administrator does not).
    expect(
      bundle.contents.roles.map((role: { name: string }) => role.name),
    ).toEqual(['Editor', 'Editors', 'Unit lead', 'Viewer']);
    expect(bundle.contents.settings).toEqual([
      {
        key: 'bundleTest.beta',
        value: null,
        rollout: 20,
        rules: [
          {
            conditions: [{ key: 'role', params: { roleNames: ['Editors'] } }],
            outcome: { value: true },
          },
        ],
      },
      { key: 'bundleTest.delay', value: '5m', rollout: null, rules: [] },
    ]);

    const target = await tenantWithAdmin(app);
    const preview = await call(
      'POST',
      '/v1/config-bundles/preview',
      target.admin.headers,
      { bundle },
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ valid: true, errors: [] });
    expect(
      preview
        .json()
        .changes.filter((c: { action: string }) => c.action !== 'unchanged'),
    ).toEqual([
      { section: 'roles', ref: 'Editors', action: 'create' },
      { section: 'settings', ref: 'bundleTest.beta', action: 'create' },
      { section: 'settings', ref: 'bundleTest.delay', action: 'create' },
    ]);

    const applied = await call(
      'POST',
      '/v1/config-bundles/apply',
      target.admin.headers,
      {
        bundle,
        targetVersion: preview.json().targetVersion,
      },
    );
    expect(applied.json()).toEqual({ created: 3, updated: 0, unchanged: 3 });

    // The target now exports the same contents: the rule names the target's own role.
    const again = (
      await call('GET', '/v1/config-bundles/export', target.admin.headers)
    ).json();
    expect(again.contents).toEqual(bundle.contents);
    expect(again.checksum).toBe(bundle.checksum);
    expect(
      (
        await call('GET', '/v1/settings/bundleTest.delay', target.admin.headers)
      ).json(),
    ).toMatchObject({ value: '5m', source: 'tenant' });

    // Applying it again changes nothing.
    const second = await call(
      'POST',
      '/v1/config-bundles/preview',
      target.admin.headers,
      { bundle },
    );
    expect(
      second
        .json()
        .changes.every((c: { action: string }) => c.action === 'unchanged'),
    ).toBe(true);
  });

  it('refuses a damaged bundle, an unknown section and a value the target refuses, applying nothing', async () => {
    const source = await configuredTenant();
    const bundle = (
      await call('GET', '/v1/config-bundles/export', source.admin.headers)
    ).json();
    const target = await tenantWithAdmin(app);
    const check = async (changed: object) => {
      const res = await call(
        'POST',
        '/v1/config-bundles/preview',
        target.admin.headers,
        {
          bundle: changed,
        },
      );
      expect(res.statusCode).toBe(200);
      return res.json();
    };
    expect(
      (await check({ ...bundle, checksum: `sha256:${'0'.repeat(64)}` })).valid,
    ).toBe(false);

    const { createHash } = await import('node:crypto');
    const sealed = (contents: object) => ({
      ...bundle,
      contents,
      checksum: `sha256:${createHash('sha256')
        .update(JSON.stringify(canonical(contents)))
        .digest('hex')}`,
    });
    // (Our own sealing needs the service's canonical form: the preview says why it fails.)
    const ghost = await check(sealed({ ghost: [] }));
    expect(ghost.valid).toBe(false);
    expect(ghost.errors.map((e: { section: string }) => e.section)).toContain(
      'ghost',
    );

    const apply = await call(
      'POST',
      '/v1/config-bundles/apply',
      target.admin.headers,
      {
        bundle: { ...bundle, checksum: `sha256:${'0'.repeat(64)}` },
        targetVersion: `sha256:${'1'.repeat(64)}`,
      },
    );
    expect([400, 409]).toContain(apply.statusCode);
    const held = (
      await call('GET', '/v1/config-bundles/export', target.admin.headers)
    ).json().contents.roles;
    expect(held.map((role: { name: string }) => role.name)).not.toContain(
      'Editors',
    );
  });

  it('refuses to apply when the target changed since the preview (409 config_changed)', async () => {
    const source = await configuredTenant();
    const bundle = (
      await call('GET', '/v1/config-bundles/export', source.admin.headers)
    ).json();
    const target = await tenantWithAdmin(app);
    const preview = (
      await call('POST', '/v1/config-bundles/preview', target.admin.headers, {
        bundle,
      })
    ).json();
    await call('PUT', '/v1/settings/bundleTest.delay', target.admin.headers, {
      value: '9m',
    });
    const res = await call(
      'POST',
      '/v1/config-bundles/apply',
      target.admin.headers,
      {
        bundle,
        targetVersion: preview.targetVersion,
      },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('config_changed');
    expect(
      (
        await call('GET', '/v1/settings/bundleTest.delay', target.admin.headers)
      ).json().value,
    ).toBe('9m');
  });

  it('is for who may export and apply', async () => {
    const t = await tenantWithAdmin(app);
    const plain = await member(app, t.tenantId, []);
    expect(
      (await call('GET', '/v1/config-bundles/export', plain.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', '/v1/config-bundles/preview', plain.headers, {
          bundle: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', '/v1/config-bundles/export', {})).statusCode,
    ).toBe(401);
  });
});

/** Keys sorted, as the service's checksum sees them (enough for this test's shapes). */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}
