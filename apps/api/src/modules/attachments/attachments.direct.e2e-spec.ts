import { getDrizzleToken } from '@nestjs/drizzle';
import { Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import {
  InMemoryDisk,
  StorageModule as NestStorageModule,
} from '@nestjs/storage';
import { eq } from 'drizzle-orm';
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
import type { Database } from '../../core/database/database.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { FeaturesModule } from '../features/features.module.js';
import { tenantQuotas } from '../quotas/quotas.tables.js';
import { FilesController } from '../storage/files.controller.js';
import { AttachmentsModule } from './attachments.module.js';
import { EICAR } from './attachments.scanner.js';
import { AttachmentSweepJob } from './attachments.sweep.js';
import { attachments, attachmentUploads } from './attachments.tables.js';

// Signed-URL uploads are offered with STORAGE_DRIVER=s3 (read when the module
// loads). MinIO is not available to the suite, so the configuration says s3
// and the disk is an in-memory one with app-served signed URLs: it does what S3
// does with a presigned PUT (signature, expiry, Content-Type and Content-Length
// are checked, the body streams onto the disk) and answers the HEAD and the
// ranged GET the completion reads.
vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'test-bucket',
    ATTACHMENT_MAX_MB: '1',
    MALWARE_SCANNER: 'memory',
    REDIS_PREFIX: `test-attachments-direct-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

const disk = new InMemoryDisk({
  signedUrls: {
    baseUrl: 'http://127.0.0.1/files',
    keys: ['direct-e2e-signing-key-32-characters-long'],
  },
});

/** The disk the app uses, and the route that serves its signed URLs. */
@Module({
  imports: [
    NestStorageModule.forRoot({ default: 'files', disks: { files: disk } }),
  ],
  controllers: [FilesController],
})
class TestStorageModule {}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n',
);

interface Presigned {
  uploadId: string;
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

describe('direct uploads to the object store (e2e, STORAGE_DRIVER=s3)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let editor: Member;
  let admin: Member;
  let viewer: Member;
  let item: { id: string };

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      TestStorageModule,
      FeaturesModule,
      testItemsModule({ imports: [AttachmentsModule.forRecord(TEST_ITEM)] }),
    );
    ({ tenantId, admin, editor, viewer } = await recordsTenant(app));
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(async () => {
    item = await createTestItem(app, editor.headers);
  });

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);
  it('says in GET /v1/features that direct uploads are on', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/features',
      headers: editor.headers,
    });
    expect(response.json()).toMatchObject({ presignedUploads: true });
  });

  const base = () => `/v1/test-items/${item.id}/attachments`;
  const presign = (headers: Headers, body: object = {}) =>
    app.inject({
      method: 'POST',
      url: `${base()}/presign`,
      headers,
      payload: {
        name: '../../report.pdf',
        size: PDF.length,
        contentType: 'application/pdf',
        ...body,
      },
    });
  const complete = (headers: Headers, uploadId: string) =>
    app.inject({
      method: 'POST',
      url: `${base()}/complete`,
      headers,
      payload: { uploadId },
    });
  /** The PUT a client makes to the URL: the signed headers, as they are. */
  const put = (presigned: Presigned, data: Buffer) => {
    const { pathname, search } = new URL(presigned.url);
    return app.inject({
      method: 'PUT',
      url: pathname + search,
      headers: presigned.headers,
      payload: data,
    });
  };
  const uploadRow = async (uploadId: string) =>
    (
      await inTenant(() =>
        db()
          .select()
          .from(attachmentUploads)
          .where(eq(attachmentUploads.id, uploadId)),
      )
    )[0];
  const announce = async (data = PDF, body: object = {}) => {
    const response = await presign(editor.headers, {
      size: data.length,
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    const presigned = response.json<Presigned>();
    const sent = await put(presigned, data);
    expect(sent.statusCode, sent.body).toBe(200);
    return presigned;
  };
  const status = async (id: string) => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/attachments/${id}`,
      headers: editor.headers,
    });
    return response.statusCode === 404
      ? 'gone'
      : response.json<{ scanStatus: string }>().scanStatus;
  };

  it('presigns a PUT bound to a key the server chose, then attaches a copy of what was PUT, through the same path as an upload', async () => {
    const response = await presign(editor.headers);
    expect(response.statusCode, response.body).toBe(201);
    const presigned = response.json<Presigned>();
    expect(presigned).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
    });
    expect(presigned).not.toHaveProperty('key');
    const minutes =
      (new Date(presigned.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    const pending = (await uploadRow(presigned.uploadId))!;
    expect(pending.key).toMatch(
      new RegExp(`^tenants/${tenantId}/attachments/[0-9a-f-]{36}$`),
    );
    // Nothing is attached before the file is there and the upload completed.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: base(),
          headers: editor.headers,
        })
      ).json<{ items: unknown[] }>().items,
    ).toEqual([]);
    // Complete before the PUT: try again later, the upload stays.
    const early = await complete(editor.headers, presigned.uploadId);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({
      code: 'attachment_upload_incomplete',
    });

    expect((await put(presigned, PDF)).statusCode).toBe(200);
    // A body of another size is refused by the store.
    expect(
      (await put(presigned, Buffer.concat([PDF, PDF]))).statusCode,
    ).toBeGreaterThanOrEqual(400);

    const done = await complete(editor.headers, presigned.uploadId);
    expect(done.statusCode, done.body).toBe(201);
    const attachment = done.json<{ id: string }>();
    expect(done.json()).toMatchObject({
      subject: 'TestItem',
      recordId: item.id,
      name: 'report.pdf',
      size: PDF.length,
      contentType: 'application/pdf',
      uploadedBy: `user:${editor.id}`,
      // The malware scan applies, as to any upload.
      scanStatus: 'pending',
    });
    const [row] = await inTenant(() =>
      db().select().from(attachments).where(eq(attachments.id, attachment.id)),
    );
    // A copy on a key of the server's own; what was PUT is gone.
    expect(row!.key).not.toBe(pending.key);
    expect(await disk.exists(pending.key)).toBe(false);
    expect(await disk.exists(row!.key)).toBe(true);
    const entries = await inTenant(() =>
      db().select().from(auditLog).where(eq(auditLog.targetId, attachment.id)),
    );
    expect(entries.map((e) => e.action)).toContain('attachment.added');
    await vi.waitFor(
      async () => expect(await status(attachment.id)).toBe('clean'),
      {
        timeout: 30_000,
        interval: 100,
      },
    );
    // Completing twice makes one attachment.
    expect(
      (await complete(editor.headers, presigned.uploadId)).statusCode,
    ).toBe(404);
  });

  it('scans what was PUT: an infected file is deleted once it is attached', async () => {
    const infected = Buffer.concat([PDF, Buffer.from(EICAR)]);
    const presigned = await announce(infected);
    const done = await complete(editor.headers, presigned.uploadId);
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json()).toMatchObject({ scanStatus: 'pending' });
    await vi.waitFor(
      async () =>
        expect(await status(done.json<{ id: string }>().id)).toBe('gone'),
      { timeout: 30_000, interval: 100 },
    );
  });

  it('refuses what an upload refuses: size, type, the right to the record, the quota; and what is not what was announced', async () => {
    expect(
      (await presign(editor.headers, { size: 2 * 1024 * 1024 })).statusCode,
    ).toBe(413);
    expect(
      (
        await presign(editor.headers, {
          contentType: 'application/x-msdownload',
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await presign(editor.headers, {
          contentType: 'application/octet-stream',
        })
      ).statusCode,
    ).toBe(415);
    expect((await presign(viewer.headers)).statusCode).toBe(403);

    // The bytes are not a PDF whatever was declared: deleted, nothing attached.
    const text = Buffer.alloc(PDF.length, 0x41);
    const presigned = await announce(text);
    const key = (await uploadRow(presigned.uploadId))!.key;
    const refused = await complete(editor.headers, presigned.uploadId);
    expect(refused.statusCode).toBe(415);
    expect(await disk.exists(key)).toBe(false);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: base(),
          headers: editor.headers,
        })
      ).json<{
        items: unknown[];
      }>().items,
    ).toEqual([]);

    // Someone else's upload is a 404.
    const mine = await announce();
    expect((await complete(admin.headers, mine.uploadId)).statusCode).toBe(404);

    const team = await recordsTenant(app);
    await app.get(Tenancy).run(team.tenantId, () =>
      db()
        .insert(tenantQuotas)
        .values({ tenantId: team.tenantId, limits: { storageBytes: 10 } }),
    );
    const teamItem = await createTestItem(app, team.editor.headers);
    const full = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${teamItem.id}/attachments/presign`,
      headers: team.editor.headers,
      payload: {
        name: 'a.pdf',
        size: PDF.length,
        contentType: 'application/pdf',
      },
    });
    expect(full.statusCode).toBe(422);
    expect(full.json()).toMatchObject({ code: 'quota_exceeded' });
  });

  it('removes an upload nobody completed, with its object, once its link has expired; a late completion is 410', async () => {
    const abandoned = await announce();
    const row = (await uploadRow(abandoned.uploadId))!;
    expect(await disk.exists(row.key)).toBe(true);
    // Within the grace after the expiry, the sweep leaves it alone.
    await inTenant(() =>
      db()
        .update(attachmentUploads)
        .set({ expiresAt: new Date(Date.now() - 5 * 60 * 1000) })
        .where(eq(attachmentUploads.id, row.id)),
    );
    await app.get(AttachmentSweepJob).run();
    expect(await disk.exists(row.key)).toBe(true);

    await inTenant(() =>
      db()
        .update(attachmentUploads)
        .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(attachmentUploads.id, row.id)),
    );
    const late = await complete(editor.headers, abandoned.uploadId);
    expect(late.statusCode).toBe(410);
    expect(late.json()).toMatchObject({ code: 'attachment_upload_expired' });
    expect(await disk.exists(row.key)).toBe(false);

    // A second one, never completed and never refused: the sweep deletes it and audits it.
    const forgotten = await announce();
    const forgottenRow = (await uploadRow(forgotten.uploadId))!;
    await inTenant(() =>
      db()
        .update(attachmentUploads)
        .set({ expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(attachmentUploads.id, forgottenRow.id)),
    );
    expect(await app.get(AttachmentSweepJob).run()).toBeGreaterThanOrEqual(1);
    expect(await disk.exists(forgottenRow.key)).toBe(false);
    expect(await uploadRow(forgotten.uploadId)).toBeUndefined();
    const swept = await inTenant(() =>
      db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'attachments.uploads-swept')),
    );
    expect(
      swept.some((entry) =>
        JSON.stringify(entry.details).includes(forgotten.uploadId),
      ),
    ).toBe(true);
  });
});
