import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import sharp from 'sharp';
import {
  accessModules,
  member,
  seededAdmin,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { StorageModule } from '../storage/storage.module.js';
import { BrandingModule } from './branding.module.js';
import { BrandingService } from './branding.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-branding-${process.pid}-${Date.now()}`;
  process.env.OPERATOR_TENANT = 'operators';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
  process.env.DATA_ENCRYPTION_KEYS = Buffer.alloc(32, 7).toString('base64');
  process.env.STORAGE_DRIVER = 'memory';
});

const raster = (format: 'png' | 'jpeg') =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
    [format]()
    .toBuffer();
const SVG = Buffer.from('<svg><script>alert(1)</script></svg>');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
/** The PNG signature and filler: recognized by its bytes, but no image. */
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

/** A multipart body with one file field, as a browser sends it. */
function multipart(bytes: Buffer, filename: string, contentType: string) {
  const boundary = `----test${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('branding (e2e)', () => {
  let app: NestNodeApplication;
  let operator: Awaited<ReturnType<typeof seededAdmin>>;
  let png: Buffer;
  let jpeg: Buffer;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), StorageModule, BrandingModule);
    operator = await seededAdmin(app);
    [png, jpeg] = await Promise.all([raster('png'), raster('jpeg')]);
  });
  afterAll(() => app.close());

  const call = (
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string> = {},
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const upload = (
    url: string,
    headers: Record<string, string>,
    bytes: Buffer,
    filename = 'logo.png',
    contentType = 'image/png',
  ) => {
    const body = multipart(bytes, filename, contentType);
    return app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...body.headers },
      payload: body.payload,
    });
  };
  const logo = (tenantId: string, dark = false) =>
    call('GET', `/v1/branding/${tenantId}/logo${dark ? '/dark' : ''}`);

  it('starts unbranded, and an administrator sets the colour and the sender name', async () => {
    const t = await tenantWithAdmin(app);
    expect((await call('GET', '/v1/branding', t.admin.headers)).json()).toEqual(
      {
        primaryColor: null,
        darkPrimaryColor: null,
        mailFromName: null,
        logoUrl: null,
        darkLogoUrl: null,
        locked: false,
        canEdit: true,
      },
    );
    const set = await call('PUT', '/v1/branding', t.admin.headers, {
      primaryColor: '#0A84FF',
      mailFromName: 'Acme Support',
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      primaryColor: '#0A84FF',
      mailFromName: 'Acme Support',
    });
    // The values are the tenant's settings.
    expect(
      (
        await call('GET', '/v1/settings/branding.primaryColor', t.admin.headers)
      ).json(),
    ).toMatchObject({ value: '#0A84FF', source: 'tenant' });
    // Another tenant is unaffected.
    const other = await tenantWithAdmin(app);
    expect(
      (await call('GET', '/v1/branding', other.admin.headers)).json(),
    ).toMatchObject({ primaryColor: null, mailFromName: null });
    // null removes one, an absent key stays.
    const cleared = await call('PUT', '/v1/branding', t.admin.headers, {
      primaryColor: null,
    });
    expect(cleared.json()).toMatchObject({
      primaryColor: null,
      mailFromName: 'Acme Support',
    });
  });

  it.each([
    'red',
    'rgb(0,0,0)',
    '#fff',
    '#12345g',
    'url(https://evil.example/x.css)',
    '#000000;background:url(x)',
    '#000000"><script>',
    '',
  ])('refuses the colour %j, here and in the settings API', async (bad) => {
    const t = await tenantWithAdmin(app);
    expect(
      (
        await call('PUT', '/v1/branding', t.admin.headers, {
          primaryColor: bad,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(
          'PUT',
          '/v1/settings/branding.primaryColor',
          t.admin.headers,
          {
            value: bad,
          },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('GET', '/v1/branding', t.admin.headers)).json().primaryColor,
    ).toBeNull();
  });

  it.each([
    'Evil\r\nBcc: victim@example.com',
    'Name <attacker@example.com>',
    'a@b.c',
    'x\u{202E}y',
    '   ',
    'x'.repeat(61),
  ])('refuses the sender name %j', async (bad) => {
    const t = await tenantWithAdmin(app);
    expect(
      (
        await call('PUT', '/v1/branding', t.admin.headers, {
          mailFromName: bad,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('is for who may update branding; everyone signed in reads it', async () => {
    const t = await tenantWithAdmin(app);
    const plain = await member(app, t.tenantId, []);
    const view = await call('GET', '/v1/branding', plain.headers);
    expect(view.statusCode).toBe(200);
    expect(view.json().canEdit).toBe(false);
    expect(
      (
        await call('PUT', '/v1/branding', plain.headers, {
          primaryColor: '#000000',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await upload('/v1/branding/logo', plain.headers, png)).statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', '/v1/branding/logo', plain.headers)).statusCode,
    ).toBe(403);
    expect((await call('GET', '/v1/branding')).statusCode).toBe(401);
  });

  describe('the logo', () => {
    it('is recognized by its bytes, served publicly, replaced and removed', async () => {
      const t = await tenantWithAdmin(app);
      const first = await upload('/v1/branding/logo', t.admin.headers, png);
      expect(first.statusCode).toBe(201);
      expect(first.json().logoUrl).toBe(`/v1/branding/${t.tenantId}/logo`);

      // No sign-in needed: a mail client shows it.
      const file = await logo(t.tenantId);
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');

      // A new one replaces it, whatever the name says.
      expect(
        (
          await upload(
            '/v1/branding/logo',
            t.admin.headers,
            jpeg,
            'x.png',
            'image/png',
          )
        ).statusCode,
      ).toBe(201);
      expect((await logo(t.tenantId)).headers['content-type']).toBe(
        'image/jpeg',
      );

      // Another tenant has none.
      const other = await tenantWithAdmin(app);
      expect((await logo(other.tenantId)).statusCode).toBe(404);

      expect(
        (await call('DELETE', '/v1/branding/logo', t.admin.headers)).statusCode,
      ).toBe(204);
      expect((await logo(t.tenantId)).statusCode).toBe(404);
      expect(
        (await call('DELETE', '/v1/branding/logo', t.admin.headers)).statusCode,
      ).toBe(404);
      expect(
        (await call('GET', '/v1/branding', t.admin.headers)).json().logoUrl,
      ).toBeNull();
    });

    it.each([
      ['an SVG', SVG, 'logo.svg', 'image/svg+xml'],
      ['an SVG named .png', SVG, 'logo.png', 'image/png'],
      ['HTML named .png', HTML, 'logo.png', 'image/png'],
      ['text', Buffer.from('plain'), 'logo.txt', 'text/plain'],
      ['a PNG signature with no image', FAKE_PNG, 'l.png', 'image/png'],
    ])('refuses %s', async (_name, bytes, filename, contentType) => {
      const t = await tenantWithAdmin(app);
      const res = await upload(
        '/v1/branding/logo',
        t.admin.headers,
        bytes,
        filename,
        contentType,
      );
      expect([400, 415]).toContain(res.statusCode);
      expect((await logo(t.tenantId)).statusCode).toBe(404);
    });

    it('keeps a dark-mode logo and colour apart, with the same checks', async () => {
      const t = await tenantWithAdmin(app);
      expect(
        (
          await call('PUT', '/v1/branding', t.admin.headers, {
            darkPrimaryColor: '#abcdef',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('PUT', '/v1/branding', t.admin.headers, {
            darkPrimaryColor: 'red',
          })
        ).statusCode,
      ).toBe(400);
      const set = await upload('/v1/branding/logo/dark', t.admin.headers, png);
      expect(set.json()).toMatchObject({
        darkPrimaryColor: '#abcdef',
        darkLogoUrl: `/v1/branding/${t.tenantId}/logo/dark`,
        logoUrl: null,
      });
      expect((await logo(t.tenantId, true)).headers['content-type']).toBe(
        'image/png',
      );
      // The logo is its own: none yet.
      expect((await logo(t.tenantId)).statusCode).toBe(404);
      expect(
        (
          await upload(
            '/v1/branding/logo/dark',
            t.admin.headers,
            SVG,
            'd.svg',
            'image/svg+xml',
          )
        ).statusCode,
      ).toBe(415);
      expect(
        (await call('DELETE', '/v1/branding/logo/dark', t.admin.headers))
          .statusCode,
      ).toBe(204);
      expect((await logo(t.tenantId, true)).statusCode).toBe(404);
      expect(
        (await call('DELETE', '/v1/branding/logo/dark', t.admin.headers))
          .statusCode,
      ).toBe(404);
    });

    it('refuses a file over 512 KB and keeps the logo it has', async () => {
      const t = await tenantWithAdmin(app);
      expect(
        (await upload('/v1/branding/logo', t.admin.headers, png)).statusCode,
      ).toBe(201);
      const big = Buffer.concat([png, Buffer.alloc(600 * 1024)]);
      expect(
        (await upload('/v1/branding/logo', t.admin.headers, big)).statusCode,
      ).toBe(413);
      expect((await logo(t.tenantId)).statusCode).toBe(200);
    });

    it('answers 404 for an id that is no tenant, 400 for one that is no id', async () => {
      expect((await logo(randomUUID())).statusCode).toBe(404);
      expect(
        (await call('GET', '/v1/branding/not-an-id/logo')).statusCode,
      ).toBe(400);
    });

    it('needs a file', async () => {
      const t = await tenantWithAdmin(app);
      const res = await call('POST', '/v1/branding/logo', t.admin.headers);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });
  });

  it('answers the brand of a host before sign-in: nothing on the app’s own host', async () => {
    const res = await call('GET', '/v1/branding/host');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      primaryColor: null,
      darkPrimaryColor: null,
      mailFromName: null,
      logoUrl: null,
      darkLogoUrl: null,
    });
  });

  describe('the operators’ lock', () => {
    it('freezes the tenant’s branding through every way in, and lifts', async () => {
      const t = await tenantWithAdmin(app);
      const slug = (await app.get(Tenancy).find(t.tenantId))!.slug;
      await call('PUT', '/v1/branding', t.admin.headers, {
        primaryColor: '#112233',
      });
      await upload('/v1/branding/logo', t.admin.headers, png);

      // A tenant's administrator can't lock or unlock.
      expect(
        (
          await call('PUT', '/v1/settings/branding.locked', t.admin.headers, {
            value: true,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call(
            'PUT',
            '/v1/settings/branding.locked/platform',
            t.admin.headers,
            { value: true },
          )
        ).statusCode,
      ).toBe(403);

      // The operators lock it for this tenant alone: a platform rule on its slug.
      const lock = await call(
        'PUT',
        '/v1/settings/branding.locked/platform',
        operator.headers,
        {
          value: false,
          rules: [
            {
              conditions: [{ key: 'tenantSlug', params: { slugs: [slug] } }],
              outcome: { value: true },
            },
          ],
        },
      );
      expect(lock.statusCode).toBe(200);
      try {
        expect(
          (await call('GET', '/v1/branding', t.admin.headers)).json(),
        ).toMatchObject({
          locked: true,
          canEdit: false,
          primaryColor: '#112233',
        });
        const refused = (res: {
          statusCode: number;
          json: () => { code?: string };
        }) => {
          expect(res.statusCode).toBe(409);
          expect(res.json().code).toBe('branding_locked');
        };
        refused(
          await call('PUT', '/v1/branding', t.admin.headers, {
            primaryColor: '#000000',
          }),
        );
        refused(
          await call(
            'PUT',
            '/v1/settings/branding.primaryColor',
            t.admin.headers,
            { value: '#000000' },
          ),
        );
        expect(
          (
            await call(
              'DELETE',
              '/v1/settings/branding.primaryColor',
              t.admin.headers,
            )
          ).statusCode,
        ).toBe(409);
        refused(
          await upload(
            '/v1/branding/logo',
            t.admin.headers,
            jpeg,
            'l.jpg',
            'image/jpeg',
          ),
        );
        refused(await call('DELETE', '/v1/branding/logo', t.admin.headers));
        refused(
          await upload(
            '/v1/branding/logo/dark',
            t.admin.headers,
            jpeg,
            'd.jpg',
            'image/jpeg',
          ),
        );
        // What was stored stays in force, and the logo is still served.
        expect((await logo(t.tenantId)).statusCode).toBe(200);
        // Other tenants are free.
        const free = await tenantWithAdmin(app);
        expect(
          (
            await call('PUT', '/v1/branding', free.admin.headers, {
              primaryColor: '#445566',
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        expect(
          (
            await call(
              'DELETE',
              '/v1/settings/branding.locked/platform',
              operator.headers,
            )
          ).statusCode,
        ).toBe(204);
      }
      expect(
        (
          await call('PUT', '/v1/branding', t.admin.headers, {
            primaryColor: '#000000',
          })
        ).statusCode,
      ).toBe(200);
    });

    it('can set the values instead: an enforced platform value beats the tenant’s', async () => {
      const t = await tenantWithAdmin(app);
      await call('PUT', '/v1/branding', t.admin.headers, {
        primaryColor: '#112233',
      });
      await call(
        'PUT',
        '/v1/settings/branding.primaryColor/platform',
        operator.headers,
        {
          value: '#abcdef',
          enforced: true,
        },
      );
      try {
        expect(
          (await call('GET', '/v1/branding', t.admin.headers)).json()
            .primaryColor,
        ).toBe('#abcdef');
      } finally {
        await call(
          'DELETE',
          '/v1/settings/branding.primaryColor/platform',
          operator.headers,
        );
      }
    });
  });

  it('records the logo changes in the audit log', async () => {
    const t = await tenantWithAdmin(app);
    await upload('/v1/branding/logo', t.admin.headers, png);
    await call('DELETE', '/v1/branding/logo', t.admin.headers);
    const db = app.get<Database>(getDrizzleToken());
    const rows = await app
      .get(Tenancy)
      .run(t.tenantId, () =>
        db.select({ action: auditLog.action }).from(auditLog),
      );
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('branding.logo-changed');
    expect(actions).toContain('branding.logo-removed');
  });

  it('gives mail and documents the brand of the current tenant', async () => {
    const t = await tenantWithAdmin(app);
    await call('PUT', '/v1/branding', t.admin.headers, {
      primaryColor: '#0a84ff',
      mailFromName: 'Acme Support',
    });
    await upload('/v1/branding/logo', t.admin.headers, png);
    const service = app.get(BrandingService);
    const tenancy = app.get(Tenancy);
    const mail = await tenancy.run(t.tenantId, () => service.current());
    expect(mail).toMatchObject({ name: 'Acme Support', color: '#0a84ff' });
    expect(mail?.logoUrl).toMatch(
      new RegExp(`/v1/branding/${t.tenantId}/logo$`),
    );
    const doc = await tenancy.run(t.tenantId, () => service.forDocument());
    expect(doc.logo).toMatch(/^data:image\/png;base64,/);
    // Another tenant is unbranded.
    const plain = await tenantWithAdmin(app);
    expect(
      await tenancy.run(plain.tenantId, () => service.current()),
    ).toMatchObject({
      name: null,
      color: '#1f2328',
      logoUrl: null,
    });
  });
});
