import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { bootModules } from '../../../test/boot.js';
import {
  createTestItem,
  type Headers,
  type Member,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { testItems } from '../../../test/fixtures/test-items/test-items.tables.js';
import type { Database } from '../../core/database/database.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { RecycleBinPurgeJob } from '../records/recycle-bin.job.js';
import { StorageModule } from '../storage/storage.module.js';
import { tenantQuotas } from '../quotas/quotas.tables.js';
import { AttachmentsModule } from './attachments.module.js';
import { AttachmentSweepJob } from './attachments.sweep.js';
import { attachments, attachmentUploads } from './attachments.tables.js';

// A small limit, so the test of it sends 1 MB, not 25 (read when the module loads).
vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    ATTACHMENT_MAX_MB: '1',
    REDIS_PREFIX: `test-attachments-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452000000010000000108060000001f15c489', 'hex'),
]);
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n',
);
const TEXT = Buffer.from('Minutes of the meeting\nAll agreed.\n');

interface File {
  name: string;
  type: string;
  data: Buffer;
}

/** A multipart body with the one field `file`. */
function multipart(file: File | null, fields: Record<string, string> = {}) {
  const boundary = `----test${randomUUID()}`;
  const parts: Buffer[] = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
        'utf8',
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

interface Attachment {
  id: string;
  name: string;
  size: number;
  contentType: string;
  uploadedBy: string;
  scanStatus: string;
  renditionStatus: string | null;
  renditions: Record<string, { width: number; height: number; size: number }>;
}

describe('attachments on test items (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Member;
  let editor: Member;
  let other: Member;
  let viewer: Member;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      StorageModule,
      testItemsModule({ imports: [AttachmentsModule.forRecord(TEST_ITEM)] }),
    );
    ({ tenantId, admin, editor, other, viewer } = await recordsTenant(app));
  });
  afterAll(async () => {
    await app?.close();
  });

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);
  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Headers,
  ) => app.inject({ method, url, headers });
  const upload = (
    headers: Headers,
    itemId: string,
    file: File | null,
    fields = {},
  ) => {
    const body = multipart(file, fields);
    return app.inject({
      method: 'POST',
      url: `/v1/test-items/${itemId}/attachments`,
      headers: { ...headers, 'content-type': body.contentType },
      payload: body.payload,
    });
  };
  const attach = async (headers: Headers, itemId: string, file: File) => {
    const response = await upload(headers, itemId, file);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Attachment>();
  };
  /** The bytes behind a signed link: the app serves them on its own route. */
  const fetchSigned = async (location: string) => {
    const { pathname, search } = new URL(location);
    return app.inject({ method: 'GET', url: pathname + search });
  };
  const files = async () => {
    const disk = app.get(StorageDisk);
    const keys: string[] = [];
    for await (const entry of disk.listAll({ prefix: 'tenants/' })) {
      keys.push(entry.key);
    }
    return keys;
  };

  it('stores what it recognizes, lists it, and serves it through a signed link', async () => {
    const item = await createTestItem(app, editor.headers);
    const png = await attach(editor.headers, item.id, {
      name: 'dot.png',
      type: 'image/png',
      data: PNG,
    });
    expect(png).toMatchObject({
      subject: 'TestItem',
      recordId: item.id,
      name: 'dot.png',
      size: PNG.length,
      contentType: 'image/png',
      uploadedBy: `user:${editor.id}`,
      scanStatus: 'clean',
    });
    expect(png).not.toHaveProperty('key');
    await attach(editor.headers, item.id, {
      name: 'report.pdf',
      type: 'application/pdf',
      data: PDF,
    });
    // Declared as nothing in particular: the bytes decide; a path is cut to its name, accents kept.
    const text = await attach(editor.headers, item.id, {
      name: '../../résumé minutes.txt',
      type: 'application/octet-stream',
      data: TEXT,
    });
    expect(text.contentType).toBe('text/plain; charset=utf-8');
    expect(text.name).toBe('résumé minutes.txt');

    const list = await call(
      'GET',
      `/v1/test-items/${item.id}/attachments`,
      editor.headers,
    );
    expect(
      list
        .json<{ items: Attachment[] }>()
        .items.map((a) => [a.name, a.size, a.contentType]),
    ).toEqual([
      ['résumé minutes.txt', TEXT.length, 'text/plain; charset=utf-8'],
      ['report.pdf', PDF.length, 'application/pdf'],
      ['dot.png', PNG.length, 'image/png'],
    ]);
    const filtered = await call(
      'GET',
      `/v1/test-items/${item.id}/attachments?contentType=application/pdf`,
      editor.headers,
    );
    expect(
      filtered.json<{ items: Attachment[] }>().items.map((a) => a.name),
    ).toEqual(['report.pdf']);
    expect(
      (
        await call('GET', `/v1/attachments/${png.id}`, editor.headers)
      ).json<Attachment>(),
    ).toMatchObject({ id: png.id, name: 'dot.png' });

    const download = await call(
      'GET',
      `/v1/attachments/${png.id}/download`,
      editor.headers,
    );
    expect(download.statusCode).toBe(302);
    const file = await fetchSigned(download.headers.location as string);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(PNG)).toBe(true);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['content-disposition']).toContain('dot.png');

    // Text is served as a plain-text download, never run: HTML can't script.
    const html = await attach(editor.headers, item.id, {
      name: 'page.html',
      type: 'text/plain',
      data: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    const htmlLink = await call(
      'GET',
      `/v1/attachments/${html.id}/download`,
      editor.headers,
    );
    const served = await fetchSigned(htmlLink.headers.location as string);
    expect(served.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(served.headers['content-disposition']).toMatch(/^attachment/);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    // A PDF may be shown inline, on request; an image never is.
    const inline = await call(
      'GET',
      `/v1/attachments/${list.json<{ items: Attachment[] }>().items[1]!.id}/download?inline=true`,
      editor.headers,
    );
    expect(
      (await fetchSigned(inline.headers.location as string)).headers[
        'content-disposition'
      ],
    ).toMatch(/^inline/);

    // Audited, with what was attached.
    const entries = await inTenant(() =>
      db().select().from(auditLog).where(eq(auditLog.targetId, png.id)),
    );
    expect(entries.map((entry) => entry.action)).toEqual(['attachment.added']);
    expect(entries[0]!.actor).toBe(`user:${editor.id}`);
    expect(entries[0]!.details).toMatchObject({
      subject: 'TestItem',
      recordId: item.id,
      name: 'dot.png',
      size: PNG.length,
    });
  });

  it("publishes the limits in the record's list description", async () => {
    const described = await call('GET', '/v1/lists/TestItem', editor.headers);
    expect(described.statusCode, described.body).toBe(200);
    expect(described.json()).toMatchObject({
      capabilities: { attachments: true },
      attachmentLimits: {
        maxBytes: 1024 * 1024,
        maxMb: 1,
        types: expect.arrayContaining(['image/png', 'application/pdf']),
      },
    });
  });

  it('refuses what is too large (413), not allowed or not as declared (415), and stores nothing', async () => {
    const item = await createTestItem(app, editor.headers);
    const before = (await files()).length;

    const large = await upload(editor.headers, item.id, {
      name: 'big.txt',
      type: 'text/plain',
      data: Buffer.alloc(1024 * 1024 + 1, 'a'),
    });
    expect(large.statusCode).toBe(413);

    const binary = await upload(editor.headers, item.id, {
      name: 'app.exe',
      type: 'application/octet-stream',
      data: Buffer.from([
        0, 1, 2, 3, 4, 5, 250, 251, 252, 0, 0, 0, 7, 8, 9, 10, 11,
      ]),
    });
    expect(binary.statusCode).toBe(415);

    // Text dressed up as an image.
    const mismatch = await upload(editor.headers, item.id, {
      name: 'cat.png',
      type: 'image/png',
      data: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    expect(mismatch.statusCode).toBe(415);

    expect(
      (await upload(editor.headers, item.id, null, { other: 'x' })).statusCode,
    ).toBe(400);

    const list = await call(
      'GET',
      `/v1/test-items/${item.id}/attachments`,
      editor.headers,
    );
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);
    expect((await files()).length).toBe(before);
  });

  it('hides an item the caller may not read (404), refuses an upload without TestItem.update (403)', async () => {
    const item = await createTestItem(app, editor.headers);
    const added = await attach(editor.headers, item.id, {
      name: 'a.txt',
      type: 'text/plain',
      data: TEXT,
    });

    // Another editor reads only their own items.
    const url = `/v1/test-items/${item.id}/attachments`;
    expect((await call('GET', url, other.headers)).statusCode).toBe(404);
    expect(
      (
        await upload(other.headers, item.id, {
          name: 'b.txt',
          type: 'text/plain',
          data: TEXT,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/attachments/${added.id}/download`, other.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/v1/attachments/${added.id}`, other.headers))
        .statusCode,
    ).toBe(404);

    // A viewer reads every item, changes none.
    expect(
      (await call('GET', url, viewer.headers)).json<{ items: unknown[] }>()
        .items,
    ).toHaveLength(1);
    expect(
      (
        await call(
          'GET',
          `/v1/attachments/${added.id}/download`,
          viewer.headers,
        )
      ).statusCode,
    ).toBe(302);
    expect(
      (
        await upload(viewer.headers, item.id, {
          name: 'c.txt',
          type: 'text/plain',
          data: TEXT,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'GET',
          `/v1/test-items/${randomUUID()}/attachments`,
          editor.headers,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('is removed by its uploader or whoever may change the item, not by another reader', async () => {
    const item = await createTestItem(app, editor.headers);
    const mine = await attach(editor.headers, item.id, {
      name: 'mine.txt',
      type: 'text/plain',
      data: TEXT,
    });
    // The administrator attaches one to the editor's item.
    const theirs = await attach(admin.headers, item.id, {
      name: 'theirs.pdf',
      type: 'application/pdf',
      data: PDF,
    });
    const [stored] = await inTenant(() =>
      db().select().from(attachments).where(eq(attachments.id, theirs.id)),
    );
    const disk = app.get(StorageDisk);
    expect(await disk.exists(stored!.key)).toBe(true);

    const refused = await call(
      'DELETE',
      `/v1/attachments/${theirs.id}`,
      viewer.headers,
    );
    expect(refused.statusCode).toBe(403);

    // The editor may change the item: they remove the administrator's file.
    expect(
      (await call('DELETE', `/v1/attachments/${theirs.id}`, editor.headers))
        .statusCode,
    ).toBe(204);
    expect(await disk.exists(stored!.key)).toBe(false);
    // The uploader removes their own.
    expect(
      (await call('DELETE', `/v1/attachments/${mine.id}`, editor.headers))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('DELETE', `/v1/attachments/${mine.id}`, editor.headers))
        .statusCode,
    ).toBe(404);

    const entries = await inTenant(() =>
      db()
        .select()
        .from(auditLog)
        .where(inArray(auditLog.targetId, [mine.id, theirs.id])),
    );
    expect(
      entries
        .filter((entry) => entry.action === 'attachment.removed')
        .map((entry) => [entry.targetId, entry.actor]),
    ).toEqual(
      expect.arrayContaining([
        [theirs.id, `user:${editor.id}`],
        [mine.id, `user:${editor.id}`],
      ]),
    );
  });

  it("keeps a deleted item's files while it can come back; its purge deletes them", async () => {
    const item = await createTestItem(app, editor.headers);
    const added = await attach(editor.headers, item.id, {
      name: 'a.txt',
      type: 'text/plain',
      data: TEXT,
    });
    const [stored] = await inTenant(() =>
      db().select().from(attachments).where(eq(attachments.id, added.id)),
    );
    const disk = app.get(StorageDisk);

    await call('DELETE', `/v1/test-items/${item.id}`, editor.headers);
    // In the recycle bin: hidden with its item, kept.
    expect(
      (await call('GET', `/v1/attachments/${added.id}`, editor.headers))
        .statusCode,
    ).toBe(404);
    expect(await disk.exists(stored!.key)).toBe(true);
    const restored = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${item.id}/restore`,
      headers: editor.headers,
    });
    expect(restored.statusCode).toBe(200);
    expect(
      (await call('GET', `/v1/attachments/${added.id}`, editor.headers))
        .statusCode,
    ).toBe(200);

    await call('DELETE', `/v1/test-items/${item.id}`, editor.headers);
    await inTenant(() =>
      db()
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(eq(testItems.id, item.id)),
    );
    await app.get(RecycleBinPurgeJob).run();
    expect(
      await inTenant(() =>
        db().select().from(attachments).where(eq(attachments.id, added.id)),
      ),
    ).toEqual([]);
    expect(await disk.exists(stored!.key)).toBe(false);
  });

  it("refuses a file past the tenant's storage quota (422) and keeps nothing; a legal hold keeps its files (409)", async () => {
    const team = await recordsTenant(app);
    await app.get(Tenancy).run(team.tenantId, () =>
      db()
        .insert(tenantQuotas)
        .values({ tenantId: team.tenantId, limits: { storageBytes: 100 } }),
    );
    const item = await createTestItem(app, team.editor.headers);
    const before = (await files()).length;
    const refused = await upload(team.editor.headers, item.id, {
      name: 'big.txt',
      type: 'text/plain',
      data: Buffer.alloc(200, 'a'),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'quota_exceeded' });
    expect((await files()).length).toBe(before);
    const small = await attach(team.editor.headers, item.id, {
      name: 'small.txt',
      type: 'text/plain',
      data: Buffer.alloc(60, 'a'),
    });
    expect(
      (
        await upload(team.editor.headers, item.id, {
          name: 'more.txt',
          type: 'text/plain',
          data: Buffer.alloc(60, 'a'),
        })
      ).statusCode,
    ).toBe(422);

    const hold = await app.inject({
      method: 'POST',
      url: '/v1/legal-holds',
      headers: team.admin.headers,
      payload: { subject: 'TestItem', recordId: item.id, reason: 'Litigation' },
    });
    expect(hold.statusCode, hold.body).toBe(201);
    const held = await call(
      'DELETE',
      `/v1/attachments/${small.id}`,
      team.editor.headers,
    );
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ code: 'legal_hold' });
  });

  it('makes the thumbnail and preview of an image and strips the original of its metadata', async () => {
    const item = await createTestItem(app, editor.headers);
    const photo = await sharp({
      create: {
        width: 400,
        height: 200,
        channels: 3,
        background: { r: 200, g: 40, b: 40 },
      },
    })
      .withExif({ IFD0: { Make: 'ACME', Model: 'Cam 1' } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();
    const uploaded = await attach(editor.headers, item.id, {
      name: 'photo.jpg',
      type: 'image/jpeg',
      data: photo,
    });
    expect(uploaded.renditionStatus).toBe('pending');

    let ready!: Attachment;
    await vi.waitFor(
      async () => {
        ready = (
          await call('GET', `/v1/attachments/${uploaded.id}`, editor.headers)
        ).json<Attachment>();
        expect(ready.renditionStatus).toBe('ready');
      },
      { timeout: 30_000, interval: 200 },
    );
    // Upright (rotated by its orientation), fitting 256 and 1600, never enlarged.
    expect(ready.renditions.thumb).toMatchObject({ width: 128, height: 256 });
    expect(ready.renditions.preview).toMatchObject({ width: 200, height: 400 });

    const thumb = await call(
      'GET',
      `/v1/attachments/${uploaded.id}/download?rendition=thumb`,
      editor.headers,
    );
    const thumbFile = await fetchSigned(thumb.headers.location as string);
    expect(thumbFile.headers['content-type']).toBe('image/webp');
    expect((await sharp(thumbFile.rawPayload).metadata()).width).toBe(128);
    // The original no longer carries its EXIF.
    const original = await fetchSigned(
      (
        await call(
          'GET',
          `/v1/attachments/${uploaded.id}/download`,
          editor.headers,
        )
      ).headers.location as string,
    );
    expect((await sharp(original.rawPayload).metadata()).exif).toBeUndefined();
    // A non-image has no renditions.
    const text = await attach(editor.headers, item.id, {
      name: 'a.txt',
      type: 'text/plain',
      data: TEXT,
    });
    expect(text.renditionStatus).toBeNull();
    expect(
      (
        await call(
          'GET',
          `/v1/attachments/${text.id}/download?rendition=thumb`,
          editor.headers,
        )
      ).statusCode,
    ).toBe(404);
    // A file that is not the image it says is refused by the type check; a damaged image ends failed, as uploaded.
    const damaged = await attach(editor.headers, item.id, {
      name: 'broken.png',
      type: 'image/png',
      data: PNG,
    });
    await vi.waitFor(
      async () => {
        const row = (
          await call('GET', `/v1/attachments/${damaged.id}`, editor.headers)
        ).json<Attachment>();
        expect(row.renditionStatus).toBe('failed');
      },
      { timeout: 30_000, interval: 200 },
    );
  });

  describe('versions', () => {
    const replace = (
      headers: Headers,
      itemId: string,
      id: string,
      file: File | null,
      fields: Record<string, string> = {},
      extra: Headers = {},
    ) => {
      const body = multipart(file, fields);
      return app.inject({
        method: 'POST',
        url: `/v1/test-items/${itemId}/attachments/${id}/versions`,
        headers: { ...headers, ...extra, 'content-type': body.contentType },
        payload: body.payload,
      });
    };
    const bodyOf = async (id: string, version?: number) => {
      const response = await call(
        'GET',
        version
          ? `/v1/attachments/${id}/versions/${version}/download`
          : `/v1/attachments/${id}/download`,
        editor.headers,
      );
      expect(response.statusCode, response.body).toBe(302);
      return (await fetchSigned(response.headers.location as string)).body;
    };
    const txt = (text: string, name = 'plan.txt'): File => ({
      name,
      type: 'text/plain',
      data: Buffer.from(text),
    });

    it('keeps the earlier file when one is replaced, lists the history, serves an old version and restores it', async () => {
      const item = await createTestItem(app, editor.headers);
      const first = await attach(editor.headers, item.id, txt('first'));
      expect(first).toMatchObject({ version: 1, revisionNote: null });
      const read = await call(
        'GET',
        `/v1/attachments/${first.id}`,
        editor.headers,
      );
      const etag = read.headers.etag as string;
      expect(etag).toBeTruthy();

      // A stale tag is refused (412); the current one replaces the file.
      const stale = await replace(
        editor.headers,
        item.id,
        first.id,
        txt('x'),
        {},
        {
          'if-match': '"stale"',
        },
      );
      expect(stale.statusCode).toBe(412);
      expect(stale.json()).toMatchObject({ code: 'precondition_failed' });
      const second = await replace(
        editor.headers,
        item.id,
        first.id,
        txt('second'),
        { note: 'Second draft' },
        { 'if-match': etag },
      );
      expect(second.statusCode, second.body).toBe(201);
      expect(second.json()).toMatchObject({
        id: first.id,
        version: 2,
        revisionNote: 'Second draft',
        size: 6,
      });
      // The tag it was read with no longer matches: two replacements racing, one wins.
      const lost = await replace(
        editor.headers,
        item.id,
        first.id,
        txt('third'),
        {},
        {
          'if-match': etag,
        },
      );
      expect(lost.statusCode).toBe(412);

      const history = await call(
        'GET',
        `/v1/attachments/${first.id}/versions`,
        editor.headers,
      );
      expect(
        history
          .json<{
            items: { version: number; current: boolean; note: string | null }[];
          }>()
          .items.map((v) => [v.version, v.current, v.note]),
      ).toEqual([
        [2, true, 'Second draft'],
        [1, false, null],
      ]);
      expect(await bodyOf(first.id, 1)).toBe('first');
      expect(await bodyOf(first.id, 2)).toBe('second');
      expect(await bodyOf(first.id)).toBe('second');
      const missing = await call(
        'GET',
        `/v1/attachments/${first.id}/versions/9/download`,
        editor.headers,
      );
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        code: 'attachment_version_not_found',
      });

      // A reader may not restore; whoever may change the item does, as a new version.
      const restoreUrl = (n: number) =>
        `/v1/attachments/${first.id}/versions/${n}/restore`;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: restoreUrl(1),
            headers: viewer.headers,
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
      const restored = await app.inject({
        method: 'POST',
        url: restoreUrl(1),
        headers: editor.headers,
        payload: {},
      });
      expect(restored.statusCode, restored.body).toBe(201);
      expect(restored.json()).toMatchObject({
        version: 3,
        revisionNote: 'Restored from version 1',
      });
      expect(await bodyOf(first.id)).toBe('first');
      expect(await bodyOf(first.id, 2)).toBe('second');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: restoreUrl(3),
            headers: editor.headers,
            payload: {},
          })
        ).json(),
      ).toMatchObject({ code: 'attachment_version_current' });

      const entries = await inTenant(() =>
        db().select().from(auditLog).where(eq(auditLog.targetId, first.id)),
      );
      expect(entries.map((e) => e.action)).toEqual(
        expect.arrayContaining([
          'attachment.replaced',
          'attachment.version-restored',
        ]),
      );

      // Removing the attachment deletes every version's file.
      const before = (await files()).length;
      expect(
        (await call('DELETE', `/v1/attachments/${first.id}`, editor.headers))
          .statusCode,
      ).toBe(204);
      expect((await files()).length).toBe(before - 3);
    });

    it('checks a replacement like any upload, refuses an issued document, a reader, and what the quota has no room for', async () => {
      const item = await createTestItem(app, editor.headers);
      const first = await attach(editor.headers, item.id, txt('first'));
      const before = (await files()).length;
      // Too large (413), not allowed (415), a reader (403), no file (400): nothing stored.
      expect(
        (
          await replace(editor.headers, item.id, first.id, {
            name: 'big.txt',
            type: 'text/plain',
            data: Buffer.alloc(1024 * 1024 + 1, 'a'),
          })
        ).statusCode,
      ).toBe(413);
      expect(
        (
          await replace(editor.headers, item.id, first.id, {
            name: 'x.bin',
            type: 'application/octet-stream',
            data: Buffer.from([0, 1, 2, 3]),
          })
        ).statusCode,
      ).toBe(415);
      expect(
        (await replace(viewer.headers, item.id, first.id, txt('no')))
          .statusCode,
      ).toBe(403);
      expect(
        (await replace(editor.headers, item.id, first.id, null)).statusCode,
      ).toBe(400);
      expect((await files()).length).toBe(before);
      // Another record's attachment id is a 404.
      const other = await createTestItem(app, editor.headers);
      expect(
        (await replace(editor.headers, other.id, first.id, txt('no')))
          .statusCode,
      ).toBe(404);

      // An issued document never changes.
      await inTenant(() =>
        db()
          .update(attachments)
          .set({ locked: true })
          .where(eq(attachments.id, first.id)),
      );
      const locked = await replace(
        editor.headers,
        item.id,
        first.id,
        txt('again'),
      );
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ code: 'attachment_locked' });
      expect((await files()).length).toBe(before);

      // Versions count in the storage quota: 60 + 60 bytes do not fit 100.
      const team = await recordsTenant(app);
      await app.get(Tenancy).run(team.tenantId, () =>
        db()
          .insert(tenantQuotas)
          .values({ tenantId: team.tenantId, limits: { storageBytes: 100 } }),
      );
      const teamItem = await createTestItem(app, team.editor.headers);
      const small = await attach(
        team.editor.headers,
        teamItem.id,
        txt('a'.repeat(60)),
      );
      const kept = (await files()).length;
      const full = await replace(
        team.editor.headers,
        teamItem.id,
        small.id,
        txt('b'.repeat(60)),
      );
      expect(full.statusCode).toBe(422);
      expect(full.json()).toMatchObject({ code: 'quota_exceeded' });
      expect((await files()).length).toBe(kept);
    });
  });

  describe('resumable uploads', () => {
    const start = (headers: Headers, itemId: string, body: object = {}) =>
      app.inject({
        method: 'POST',
        url: `/v1/test-items/${itemId}/attachments/sessions`,
        headers,
        payload: {
          name: 'big.pdf',
          size: PDF.length,
          contentType: 'application/pdf',
          ...body,
        },
      });
    const chunk = (
      headers: Headers,
      itemId: string,
      uploadId: string,
      offset: number,
      bytes: Buffer,
    ) =>
      app.inject({
        method: 'PUT',
        url: `/v1/test-items/${itemId}/attachments/sessions/${uploadId}?offset=${offset}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
    const complete = (headers: Headers, itemId: string, uploadId: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/test-items/${itemId}/attachments/complete`,
        headers,
        payload: { uploadId },
      });
    const progress = (headers: Headers, itemId: string, uploadId: string) =>
      app.inject({
        method: 'GET',
        url: `/v1/test-items/${itemId}/attachments/sessions/${uploadId}`,
        headers,
      });
    const parts = async () =>
      (await files()).filter((key) => key.includes('.parts/'));
    const half = Math.floor(PDF.length / 2);

    it('resumes after a gap, reports progress, and attaches once complete', async () => {
      const item = await createTestItem(app, editor.headers);
      const session = (await start(editor.headers, item.id)).json<{
        uploadId: string;
        received: number;
        chunkSize: number;
        size: number;
      }>();
      expect(session).toMatchObject({ received: 0, size: PDF.length });
      const first = await chunk(
        editor.headers,
        item.id,
        session.uploadId,
        0,
        PDF.subarray(0, half),
      );
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ received: half });
      // A retried chunk, or one past a gap, stores nothing.
      for (const offset of [0, half + 5]) {
        const refused = await chunk(
          editor.headers,
          item.id,
          session.uploadId,
          offset,
          PDF.subarray(half),
        );
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({
          code: 'attachment_upload_offset_mismatch',
          received: half,
        });
      }
      // Not complete yet, and nothing is attached.
      const early = await complete(editor.headers, item.id, session.uploadId);
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({
        code: 'attachment_upload_incomplete',
      });
      expect(
        (
          await call(
            'GET',
            `/v1/test-items/${item.id}/attachments`,
            editor.headers,
          )
        ).json<{ items: unknown[] }>().items,
      ).toEqual([]);
      // Resume from what the server says it has.
      expect(
        (await progress(editor.headers, item.id, session.uploadId)).json(),
      ).toMatchObject({ received: half });
      await chunk(
        editor.headers,
        item.id,
        session.uploadId,
        half,
        PDF.subarray(half),
      );
      const done = await complete(editor.headers, item.id, session.uploadId);
      expect(done.statusCode, done.body).toBe(201);
      expect(done.json()).toMatchObject({
        name: 'big.pdf',
        size: PDF.length,
        contentType: 'application/pdf',
        uploadedBy: `user:${editor.id}`,
        scanStatus: 'clean',
      });
      expect(await parts()).toEqual([]);
      // Completing twice makes one attachment.
      expect(
        (await complete(editor.headers, item.id, session.uploadId)).statusCode,
      ).toBe(404);
      const audit = await inTenant(() =>
        db()
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, done.json<Attachment>().id)),
      );
      expect(audit.map((e) => e.action)).toContain('attachment.added');
    });

    /** The bytes the attachment keeps. */
    const storedBytes = async (attachmentId: string) => {
      const [stored] = await inTenant(() =>
        db()
          .select({ key: attachments.key })
          .from(attachments)
          .where(eq(attachments.id, attachmentId)),
      );
      const chunks: Buffer[] = [];
      for await (const part of (await app.get(StorageDisk).get(stored!.key))
        .body) {
        chunks.push(Buffer.from(part as Uint8Array));
      }
      return Buffer.concat(chunks);
    };

    it('counts no chunk the store failed to keep: the retry at the same offset assembles the file', async () => {
      const item = await createTestItem(app, editor.headers);
      const { uploadId } = (await start(editor.headers, item.id)).json<{
        uploadId: string;
      }>();
      const disk = app.get(StorageDisk);
      const move = vi
        .spyOn(disk, 'move')
        .mockRejectedValueOnce(new Error('the store is away'));
      try {
        const failed = await chunk(
          editor.headers,
          item.id,
          uploadId,
          0,
          PDF.subarray(0, half),
        );
        expect(failed.statusCode).toBe(500);
      } finally {
        move.mockRestore();
      }
      expect(
        (await progress(editor.headers, item.id, uploadId)).json(),
      ).toMatchObject({ received: 0 });
      for (const [offset, bytes] of [
        [0, PDF.subarray(0, half)],
        [half, PDF.subarray(half)],
      ] as const) {
        const sent = await chunk(
          editor.headers,
          item.id,
          uploadId,
          offset,
          bytes,
        );
        expect(sent.statusCode, sent.body).toBe(200);
      }
      const done = await complete(editor.headers, item.id, uploadId);
      expect(done.statusCode, done.body).toBe(201);
      expect(await storedBytes(done.json<Attachment>().id)).toEqual(PDF);
    });

    it('stores one of two chunks sent at one offset, and leaves its part in place', async () => {
      const item = await createTestItem(app, editor.headers);
      const { uploadId } = (await start(editor.headers, item.id)).json<{
        uploadId: string;
      }>();
      const disk = app.get(StorageDisk);
      const move = disk.move.bind(disk);
      // The first chunk's move waits while the second chunk is stored and
      // reaches the session: it must wait for the first, not replace its part.
      let moving!: () => void;
      const reached = new Promise<void>((resolve) => (moving = resolve));
      let proceed!: () => void;
      const released = new Promise<void>((resolve) => (proceed = resolve));
      const spy = vi
        .spyOn(disk, 'move')
        .mockImplementationOnce(async (from, to, options) => {
          moving();
          await released;
          return move(from, to, options);
        });
      try {
        const first = chunk(
          editor.headers,
          item.id,
          uploadId,
          0,
          PDF.subarray(0, half),
        );
        await reached;
        const second = chunk(
          editor.headers,
          item.id,
          uploadId,
          0,
          Buffer.alloc(half + 3, 0x41),
        );
        // Until the second chunk is stored and waits (a lock), or is answered (none).
        let answered = false;
        void second.finally(() => (answered = true));
        await vi.waitFor(
          async () => {
            const stored = (await parts()).filter((key) =>
              key.includes('tmp-'),
            );
            expect(answered || stored.length === 2).toBe(true);
          },
          { timeout: 5000 },
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        proceed();
        const won = await first;
        expect(won.statusCode, won.body).toBe(200);
        const raced = await second;
        expect(raced.statusCode).toBe(409);
        expect(raced.json()).toMatchObject({
          code: 'attachment_upload_offset_mismatch',
          received: half,
        });
      } finally {
        spy.mockRestore();
      }
      await chunk(editor.headers, item.id, uploadId, half, PDF.subarray(half));
      const done = await complete(editor.headers, item.id, uploadId);
      expect(done.statusCode, done.body).toBe(201);
      expect(await storedBytes(done.json<Attachment>().id)).toEqual(PDF);
    });

    it('refuses what an upload refuses on every step, and binds the session to its owner', async () => {
      const item = await createTestItem(app, editor.headers);
      expect(
        (await start(editor.headers, item.id, { size: 2 * 1024 * 1024 }))
          .statusCode,
      ).toBe(413);
      expect(
        (
          await start(editor.headers, item.id, {
            contentType: 'application/x-msdownload',
          })
        ).statusCode,
      ).toBe(415);
      expect(
        (await start(editor.headers, item.id, { contentType: '' })).statusCode,
      ).toBe(400);
      expect((await start(viewer.headers, item.id)).statusCode).toBe(403);
      // Not a PDF, whatever was declared: refused on completion, nothing attached or kept.
      const bogus = (await start(editor.headers, item.id)).json<{
        uploadId: string;
      }>();
      await chunk(
        editor.headers,
        item.id,
        bogus.uploadId,
        0,
        Buffer.alloc(PDF.length, 0x41),
      );
      const mismatch = await complete(editor.headers, item.id, bogus.uploadId);
      expect(mismatch.statusCode).toBe(415);
      expect(
        (
          await call(
            'GET',
            `/v1/test-items/${item.id}/attachments`,
            editor.headers,
          )
        ).json<{ items: unknown[] }>().items,
      ).toEqual([]);

      const mine = (await start(editor.headers, item.id)).json<{
        uploadId: string;
      }>();
      expect(
        (await progress(admin.headers, item.id, mine.uploadId)).statusCode,
      ).toBe(404);
      expect(
        (await chunk(admin.headers, item.id, mine.uploadId, 0, PDF)).statusCode,
      ).toBe(404);
      expect(
        (await complete(admin.headers, item.id, mine.uploadId)).statusCode,
      ).toBe(404);
      // Past the announced size: 413.
      expect(
        (
          await chunk(
            editor.headers,
            item.id,
            mine.uploadId,
            0,
            Buffer.concat([PDF, Buffer.from('x')]),
          )
        ).statusCode,
      ).toBe(413);

      // The quota is checked when the session opens.
      const team = await recordsTenant(app);
      await app.get(Tenancy).run(team.tenantId, () =>
        db()
          .insert(tenantQuotas)
          .values({ tenantId: team.tenantId, limits: { storageBytes: 10 } }),
      );
      const teamItem = await createTestItem(app, team.editor.headers);
      const full = await start(team.editor.headers, teamItem.id);
      expect(full.statusCode).toBe(422);
      expect(full.json()).toMatchObject({ code: 'quota_exceeded' });
    });

    it('aborts a session with its parts, and an expired one stops taking chunks and is swept', async () => {
      const item = await createTestItem(app, editor.headers);
      const before = (await parts()).length;
      const aborted = (await start(editor.headers, item.id)).json<{
        uploadId: string;
      }>();
      await chunk(
        editor.headers,
        item.id,
        aborted.uploadId,
        0,
        PDF.subarray(0, 10),
      );
      expect((await parts()).length).toBe(before + 1);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/test-items/${item.id}/attachments/sessions/${aborted.uploadId}`,
            headers: editor.headers,
          })
        ).statusCode,
      ).toBe(204);
      expect((await parts()).length).toBe(before);
      expect(
        (await progress(editor.headers, item.id, aborted.uploadId)).statusCode,
      ).toBe(404);

      const expired = (await start(editor.headers, item.id)).json<{
        uploadId: string;
      }>();
      await chunk(
        editor.headers,
        item.id,
        expired.uploadId,
        0,
        PDF.subarray(0, 10),
      );
      await inTenant(() =>
        db()
          .update(attachmentUploads)
          .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
          .where(eq(attachmentUploads.id, expired.uploadId)),
      );
      const late = await chunk(
        editor.headers,
        item.id,
        expired.uploadId,
        10,
        PDF.subarray(10, 20),
      );
      expect(late.statusCode).toBe(410);
      expect(late.json()).toMatchObject({ code: 'attachment_upload_expired' });
      await app.get(AttachmentSweepJob).run();
      expect((await parts()).length).toBe(before);
      expect(
        await inTenant(() =>
          db()
            .select()
            .from(attachmentUploads)
            .where(eq(attachmentUploads.id, expired.uploadId)),
        ),
      ).toEqual([]);
    });

    it('offers signed-URL uploads only on S3', async () => {
      const item = await createTestItem(app, editor.headers);
      const refused = await app.inject({
        method: 'POST',
        url: `/v1/test-items/${item.id}/attachments/presign`,
        headers: editor.headers,
        payload: {
          name: 'a.pdf',
          size: PDF.length,
          contentType: 'application/pdf',
        },
      });
      expect(refused.statusCode).toBe(503);
      expect(refused.json()).toMatchObject({
        code: 'presigned_uploads_unavailable',
      });
    });
  });
});
