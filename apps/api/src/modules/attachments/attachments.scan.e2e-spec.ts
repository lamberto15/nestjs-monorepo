import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
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
import { StorageModule } from '../storage/storage.module.js';
import { AttachmentsModule } from './attachments.module.js';
import { AttachmentRetryJob } from './attachments.jobs.js';
import {
  EICAR,
  MalwareScanner,
  MemoryMalwareScanner,
} from './attachments.scanner.js';
import { attachments } from './attachments.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    MALWARE_SCANNER: 'memory',
    REDIS_PREFIX: `test-attachments-scan-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

const TEXT = Buffer.from('Minutes of the meeting\nAll agreed.\n');

describe('attachments: malware scanning (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let editor: Member;
  let scanner: MemoryMalwareScanner;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      StorageModule,
      testItemsModule({ imports: [AttachmentsModule.forRecord(TEST_ITEM)] }),
    );
    ({ tenantId, editor } = await recordsTenant(app));
    scanner = app.get(MalwareScanner) as MemoryMalwareScanner;
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    scanner.down = false;
    scanner.enabled = true;
  });

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);
  const get = (url: string, headers: Headers) =>
    app.inject({ method: 'GET', url, headers });
  const upload = async (itemId: string, name: string, data: Buffer) => {
    const boundary = `----t${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${itemId}/attachments`,
      headers: {
        ...editor.headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string; scanStatus: string }>();
  };
  const status = async (id: string) =>
    (await get(`/v1/attachments/${id}`, editor.headers)).statusCode === 404
      ? 'gone'
      : (await get(`/v1/attachments/${id}`, editor.headers)).json<{
          scanStatus: string;
        }>().scanStatus;
  const settled = (id: string, expected: string) =>
    vi.waitFor(async () => expect(await status(id)).toBe(expected), {
      timeout: 30_000,
      interval: 100,
    });

  it('keeps an upload pending until it is scanned: clean is served, infected is deleted and its uploader told', async () => {
    const item = await createTestItem(app, editor.headers);
    const disk = app.get(StorageDisk);

    const clean = await upload(item.id, 'minutes.txt', TEXT);
    expect(clean.scanStatus).toBe('pending');
    await settled(clean.id, 'clean');
    expect(
      (await get(`/v1/attachments/${clean.id}/download`, editor.headers))
        .statusCode,
    ).toBe(302);

    const infected = await upload(item.id, 'eicar.txt', Buffer.from(EICAR));
    const [row] = await inTenant(() =>
      db().select().from(attachments).where(eq(attachments.id, infected.id)),
    );
    await settled(infected.id, 'gone');
    expect(await disk.exists(row!.key)).toBe(false);

    const told = await get(
      '/v1/notifications?type=attachment.rejected',
      editor.headers,
    );
    expect(
      told.json<{ items: { data: { name: string; signature: string } }[] }>()
        .items,
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'eicar.txt',
          signature: 'Eicar-Test-Signature',
        }),
      }),
    ]);
    const entries = await inTenant(() =>
      db().select().from(auditLog).where(eq(auditLog.targetId, infected.id)),
    );
    expect(
      entries.find((e) => e.action === 'attachment.rejected'),
    ).toMatchObject({
      actor: 'system:attachment-scan',
      details: expect.objectContaining({
        name: 'eicar.txt',
        signature: 'Eicar-Test-Signature',
      }),
    });
  });

  it('never calls a file clean without a scan: a scanner that is away leaves it pending (409 on download) until the retry job queues it again', async () => {
    const item = await createTestItem(app, editor.headers);
    scanner.down = true;
    const pending = await upload(item.id, 'later.txt', TEXT);
    await vi.waitFor(() => expect(scanner.scanned).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(await status(pending.id)).toBe('pending');
    const refused = await get(
      `/v1/attachments/${pending.id}/download`,
      editor.headers,
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'attachment_scan_pending' });
    // Listed and removable meanwhile; filterable by its state.
    const list = await get(
      `/v1/test-items/${item.id}/attachments?scanStatus=pending`,
      editor.headers,
    );
    expect(
      list.json<{ items: { id: string }[] }>().items.map((a) => a.id),
    ).toEqual([pending.id]);

    scanner.down = false;
    // Five minutes on, it is stuck: the job queues its scan again.
    const handled = await app
      .get(AttachmentRetryJob)
      .run(new Date(Date.now() + 10 * 60_000));
    expect(handled.scans).toBeGreaterThanOrEqual(1);
    await settled(pending.id, 'clean');
  });

  it('releases what is pending when scanning is switched off', async () => {
    const item = await createTestItem(app, editor.headers);
    scanner.down = true;
    const pending = await upload(item.id, 'stuck.txt', TEXT);
    expect(await status(pending.id)).toBe('pending');
    scanner.enabled = false;
    await app.get(AttachmentRetryJob).run(new Date(Date.now() + 10 * 60_000));
    expect(await status(pending.id)).toBe('clean');
    const released = await inTenant(() =>
      db()
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, 'attachments.released')),
    );
    expect(released.at(-1)).toMatchObject({ actor: 'system:attachment-scan' });
  });

  it('drops an infected replacement and makes the file before it current again; a resumable upload is scanned like any other', async () => {
    const item = await createTestItem(app, editor.headers);
    const first = await upload(item.id, 'minutes.txt', TEXT);
    await settled(first.id, 'clean');

    const boundary = `----t${randomUUID()}`;
    const replaced = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${item.id}/attachments/${first.id}/versions`,
      headers: {
        ...editor.headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="minutes.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from(EICAR),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(replaced.json()).toMatchObject({
      version: 2,
      scanStatus: 'pending',
    });
    await vi.waitFor(
      async () => {
        const row = (
          await get(`/v1/attachments/${first.id}`, editor.headers)
        ).json<{
          version: number;
          scanStatus: string;
        }>();
        expect(row).toMatchObject({ version: 1, scanStatus: 'clean' });
      },
      { timeout: 30_000, interval: 100 },
    );
    const history = await get(
      `/v1/attachments/${first.id}/versions`,
      editor.headers,
    );
    expect(history.json<{ items: unknown[] }>().items).toHaveLength(1);
    const entries = await inTenant(() =>
      db().select().from(auditLog).where(eq(auditLog.targetId, first.id)),
    );
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(['attachment.replaced', 'attachment.rejected']),
    );

    // A resumable upload ends in the same scan.
    const bytes = Buffer.from(EICAR);
    const session = (
      await app.inject({
        method: 'POST',
        url: `/v1/test-items/${item.id}/attachments/sessions`,
        headers: editor.headers,
        payload: {
          name: 'eicar.txt',
          size: bytes.length,
          contentType: 'text/plain',
        },
      })
    ).json<{ uploadId: string }>();
    const sent = await app.inject({
      method: 'PUT',
      url: `/v1/test-items/${item.id}/attachments/sessions/${session.uploadId}?offset=0`,
      headers: {
        ...editor.headers,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const done = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${item.id}/attachments/complete`,
      headers: editor.headers,
      payload: { uploadId: session.uploadId },
    });
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json()).toMatchObject({ scanStatus: 'pending' });
    await settled(done.json<{ id: string }>().id, 'gone');
  });
});
