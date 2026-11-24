import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { member, tenantWithAdmin } from '../../../../test/access.js';
import { bootModules } from '../../../../test/boot.js';
import { accessModules } from '../../../../test/access.js';
import type { Database } from '../../../core/database/database.js';
import { Tenancy } from '../../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../../iam/audit/audit.tables.js';
import { StorageModule } from '../../storage/storage.module.js';
import { AvatarsModule } from './avatars.module.js';
import { userAvatars } from './avatars.tables.js';

// A small limit, so the test of it sends 1 MB, not 2.
vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    STORAGE_DRIVER: 'memory',
    AVATAR_MAX_MB: '1',
  });
});

/** A real picture: the image processor decodes it (a damaged one is a 415). */
const picture = () =>
  sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  });
let PNG: Buffer;
let JPEG: Buffer;
/** A phone's photo: its maker and where it was taken in the EXIF. */
let PHOTO: Buffer;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n');

describe('user avatars (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Record<string, string>;

  beforeAll(async () => {
    PNG = await picture().png().toBuffer();
    JPEG = await picture().jpeg().toBuffer();
    PHOTO = await picture()
      .withExif({
        IFD0: { Make: 'ACME', Model: 'Cam 1' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 26/1 46/1' },
      })
      .jpeg()
      .toBuffer();
    app = await bootModules(...accessModules(), StorageModule, AvatarsModule);
    const created = await tenantWithAdmin(app);
    tenantId = created.tenantId;
    admin = created.admin.headers;
  });
  afterAll(async () => {
    await app?.close();
  });

  const put = (
    headers: Record<string, string>,
    file: { name: string; type: string; data: Buffer } | null,
  ) => {
    const boundary = '----avatar';
    const payload = file
      ? Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
          ),
          file.data,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ])
      : Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="x"\r\n\r\ny\r\n--${boundary}--\r\n`,
        );
    return app.inject({
      method: 'PUT',
      url: '/v1/account/avatar',
      headers: {
        ...headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
  };
  const keyOf = (userId: string) =>
    app
      .get<Database>(getDrizzleToken())
      .select()
      .from(userAvatars)
      .where(eq(userAvatars.userId, userId))
      .then(([row]) => row?.key);

  it('sets, shows, replaces and removes the picture; members of the tenant see it by avatarUrl', async () => {
    const ada = await member(app, tenantId, []);
    const bob = await member(app, tenantId, []);
    const disk = app.get(StorageDisk);

    const set = await put(ada.headers, {
      name: 'me.png',
      type: 'image/png',
      data: PNG,
    });
    expect(set.statusCode, set.body).toBe(200);
    const { avatarUrl } = set.json<{ avatarUrl: string }>();
    expect(avatarUrl).toMatch(new RegExp(`^/v1/people/${ada.id}/avatar\\?v=`));
    const first = (await keyOf(ada.id))!;
    // The access API's members list shows it (iam/access's @MemberAvatars()).
    const members = await app.inject({
      method: 'GET',
      url: '/v1/access/users',
      headers: admin,
    });
    expect(
      members
        .json<{ items: { id: string; avatarUrl: string | null }[] }>()
        .items.find((item) => item.id === ada.id)?.avatarUrl,
    ).toBe(avatarUrl);
    expect(first).toMatch(new RegExp(`^accounts/${ada.id}/avatar/`));

    // A member of the tenant sees it, as the image itself, from the API's own origin.
    for (const viewer of [ada, bob]) {
      const shown = await app.inject({
        method: 'GET',
        url: avatarUrl,
        headers: viewer.headers,
      });
      expect(shown.statusCode).toBe(200);
      expect(shown.rawPayload.equals(PNG)).toBe(true);
      expect(shown.headers['content-type']).toBe('image/png');
      expect(shown.headers['content-disposition']).toMatch(/^inline/);
      expect(shown.headers['cache-control']).toBe('private, max-age=300');
    }

    // Replacing it: a new `v`, the old file gone, one audit entry each.
    const replaced = await put(ada.headers, {
      name: 'me.jpg',
      type: 'image/jpeg',
      data: JPEG,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json<{ avatarUrl: string }>().avatarUrl).not.toBe(
      avatarUrl,
    );
    expect(await disk.exists(first)).toBe(false);

    // Someone else's tenant, or nobody's, has no picture to see: 404 either way.
    const stranger = await member(
      app,
      (await tenantWithAdmin(app)).tenantId,
      [],
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: avatarUrl,
          headers: stranger.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/people/${bob.id}/avatar`,
          headers: ada.headers,
        })
      ).statusCode,
    ).toBe(404);

    const key = (await keyOf(ada.id))!;
    const removed = await app.inject({
      method: 'DELETE',
      url: '/v1/account/avatar',
      headers: ada.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(await disk.exists(key)).toBe(false);
    expect(await keyOf(ada.id)).toBeUndefined();
    // Nothing to remove: no change, no entry.
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/account/avatar',
          headers: ada.headers,
        })
      ).statusCode,
    ).toBe(204);

    const entries = await app
      .get(Tenancy)
      .run(tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, ada.id)),
      );
    expect(
      entries
        .map((e) => e.action)
        .filter((a) => a.startsWith('account.avatar')),
    ).toEqual([
      'account.avatar-changed',
      'account.avatar-changed',
      'account.avatar-removed',
    ]);
  });

  it('shows a photo without its metadata: no maker, no place', async () => {
    const ada = await member(app, tenantId, []);
    expect(PHOTO.includes(Buffer.from('Cam 1'))).toBe(true);
    const set = await put(ada.headers, {
      name: 'me.jpg',
      type: 'image/jpeg',
      data: PHOTO,
    });
    expect(set.statusCode, set.body).toBe(200);
    const shown = await app.inject({
      method: 'GET',
      url: set.json<{ avatarUrl: string }>().avatarUrl,
      headers: ada.headers,
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.rawPayload.includes(Buffer.from('Cam 1'))).toBe(false);
    expect((await sharp(shown.rawPayload).metadata()).exif).toBeUndefined();
  });

  it('refuses what is not a picture, too large, or not as declared, and stores nothing', async () => {
    const ada = await member(app, tenantId, []);
    const disk = app.get(StorageDisk);
    const count = async () => {
      let n = 0;
      for await (const _ of disk.listAll({ prefix: `accounts/${ada.id}/` }))
        n += 1;
      return n;
    };
    expect(
      (
        await put(ada.headers, {
          name: 'a.pdf',
          type: 'application/pdf',
          data: PDF,
        })
      ).statusCode,
    ).toBe(415);
    // Text dressed up as an image.
    expect(
      (
        await put(ada.headers, {
          name: 'a.png',
          type: 'image/png',
          data: Buffer.from('<svg onload="alert(1)"/>'),
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await put(ada.headers, {
          name: 'big.png',
          type: 'image/png',
          data: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]),
        })
      ).statusCode,
    ).toBe(413);
    expect((await put(ada.headers, null)).statusCode).toBe(400);
    expect(await count()).toBe(0);
    expect(await keyOf(ada.id)).toBeUndefined();
  });

  it('adds the picture to who-am-I', async () => {
    const ada = await member(app, tenantId, ['viewer']);
    const me = () =>
      app
        .inject({ method: 'GET', url: '/v1/auth/me', headers: ada.headers })
        .then((response) => response.json<{ avatarUrl: string | null }>());
    expect((await me()).avatarUrl).toBeNull();
    await app.get(Tenancy).run(null, () =>
      app
        .get<Database>(getDrizzleToken())
        .insert(userAvatars)
        .values({ userId: ada.id, key: `accounts/${ada.id}/avatar/one.png` }),
    );
    expect((await me()).avatarUrl).toContain(`/v1/people/${ada.id}/avatar`);
  });
});
