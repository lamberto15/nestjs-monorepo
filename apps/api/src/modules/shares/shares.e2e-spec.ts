import { randomUUID } from 'node:crypto';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { bootModules } from '../../../test/boot.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import {
  attachmentKey,
  AttachmentsService,
} from '../attachments/attachments.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { SharesModule } from './shares.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.APP_ROLE = 'all';
  process.env.STORAGE_DRIVER = 'memory';
  process.env.DATA_ENCRYPTION_KEYS =
    'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
  process.env.MAIL_TRANSPORT = 'memory';
  process.env.WEB_URL = 'https://web.example.com';
  process.env.REDIS_PREFIX = `test-shares-${process.pid}-${Date.now()}`;
});

describe('record shares (e2e)', () => {
  let app: NestNodeApplication;
  let mailbox: InMemoryMailTransport;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      StorageModule,
      testItemsModule({
        imports: [
          SharesModule.forRecord(TEST_ITEM),
          AttachmentsModule.forRecord(TEST_ITEM),
        ],
      }),
    );
    mailbox = app.get(MailTransport) as InMemoryMailTransport;
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString();
  const share = (
    headers: Record<string, string>,
    id: string,
    payload: object,
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/test-items/${id}/shares`,
      headers,
      payload,
    });
  const open = (token: string, code?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/shared/open',
      payload: { token, ...(code && { code }) },
    });

  it('shows the chosen fields to whoever holds the link, until it is revoked', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Shared',
      body: 'secret',
    });
    const made = await share(team.editor.headers, item.id, {
      fields: ['title'],
      expiresAt: inDays(2),
    });
    expect(made.statusCode).toBe(201);
    const { token, id, url } = made.json<{
      token: string;
      id: string;
      url: string;
    }>();
    expect(url).toBe(`https://web.example.com/shared#${token}`);

    // No sign-in: the token is the proof; only the chosen fields show.
    const opened = await open(token);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      subject: 'TestItem',
      fields: { title: 'Shared' },
    });
    expect(opened.json<{ fields: object }>().fields).not.toHaveProperty('body');

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/test-items/${item.id}/shares`,
      headers: team.editor.headers,
    });
    expect(
      listed.json<{ items: { views: number; active: boolean }[] }>().items[0],
    ).toMatchObject({ views: 1, active: true });
    expect(JSON.stringify(listed.json())).not.toContain(token);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/test-items/${item.id}/shares/${id}`,
      headers: team.editor.headers,
    });
    expect(revoked.statusCode).toBe(204);
    expect((await open(token)).statusCode).toBe(404);
  });

  it('shows what the maker may read now, and nothing once the record is gone', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Before',
    });
    const { token } = (
      await share(team.editor.headers, item.id, {
        fields: ['title'],
        expiresAt: inDays(1),
      })
    ).json<{ token: string }>();
    await app.inject({
      method: 'PATCH',
      url: `/v1/test-items/${item.id}`,
      headers: team.editor.headers,
      payload: { title: 'After' },
    });
    expect((await open(token)).json()).toMatchObject({
      fields: { title: 'After' },
    });
    await app.inject({
      method: 'DELETE',
      url: `/v1/test-items/${item.id}`,
      headers: team.editor.headers,
    });
    expect((await open(token)).statusCode).toBe(404);
  });

  it('refuses who may not share, references, and an expiry out of range', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Mine',
    });
    const expiresAt = inDays(2);
    // Not theirs to read: a 404; read but not share (a viewer): a 403.
    expect(
      (
        await share(team.other.headers, item.id, {
          fields: ['title'],
          expiresAt,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await share(team.viewer.headers, item.id, {
          fields: ['title'],
          expiresAt,
        })
      ).statusCode,
    ).toBe(403);
    // A reference to another record is never shared.
    expect(
      (
        await share(team.editor.headers, item.id, {
          fields: ['parentId'],
          expiresAt,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await share(team.editor.headers, item.id, {
          fields: ['title'],
          expiresAt: inDays(400),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await share(team.editor.headers, item.id, {
          fields: ['title'],
          expiresAt: inDays(-1),
        })
      ).statusCode,
    ).toBe(400);
    // A forged or malformed token is the one 404.
    expect((await open('nope')).statusCode).toBe(404);
  });

  it('opens a link to one address only with its code', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Private',
    });
    const made = await share(team.editor.headers, item.id, {
      fields: ['title'],
      expiresAt: inDays(1),
      recipientEmail: 'Reader@Example.com',
    });
    expect(made.json()).toMatchObject({ recipientEmail: 'reader@example.com' });
    const { token } = made.json<{ token: string }>();
    expect((await open(token)).json()).toMatchObject({
      code: 'share_code_required',
    });
    expect((await open(token, '000000')).json()).toMatchObject({
      code: 'share_code_invalid',
    });

    // The mailed code opens it, once it is asked for.
    mailbox.clear();
    const sent = await app.inject({
      method: 'POST',
      url: '/v1/shared/code',
      payload: { token },
    });
    expect(sent.statusCode).toBe(204);
    await vi.waitFor(() => expect(mailbox.mails).toHaveLength(1));
    const code = /\b(\d{6})\b/.exec(JSON.stringify(mailbox.mails[0]))![1]!;
    expect((await open(token, code)).json()).toMatchObject({
      fields: { title: 'Private' },
    });
  });

  it('lists the files of a link made with files, and hands out a download link for each', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'With a file',
    });
    const boundary = '----shares';
    const upload = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${item.id}/attachments`,
      headers: {
        ...team.editor.headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="minutes.txt"\r\nContent-Type: text/plain\r\n\r\nAll agreed.\r\n--${boundary}--\r\n`,
      ),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const { id: fileId } = upload.json<{ id: string }>();

    const withFiles = (
      await share(team.editor.headers, item.id, {
        fields: ['title'],
        files: true,
        expiresAt: inDays(1),
      })
    ).json<{ token: string; files: boolean }>();
    expect(withFiles.files).toBe(true);
    const without = (
      await share(team.editor.headers, item.id, {
        fields: ['title'],
        expiresAt: inDays(1),
      })
    ).json<{ token: string }>();

    expect((await open(withFiles.token)).json()).toMatchObject({
      files: [
        {
          id: fileId,
          name: 'minutes.txt',
          contentType: expect.stringContaining('text/plain'),
        },
      ],
    });
    expect((await open(without.token)).json()).toMatchObject({ files: [] });

    const download = (token: string, id: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/shared/files/${id}`,
        payload: { token },
      });
    const link = await download(withFiles.token, fileId);
    expect(link.statusCode, link.body).toBe(200);
    expect(link.json<{ url: string }>().url).toEqual(expect.any(String));
    // A link made without files, or a file that is not the record's, is a 404.
    expect((await download(without.token, fileId)).statusCode).toBe(404);
    expect((await download(withFiles.token, randomUUID())).statusCode).toBe(
      404,
    );
  });

  it('includes an issued PDF only on a link whose fields cover the ones it shows', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Issued',
      body: 'text',
    });
    const issued = await app.get(Tenancy).run(team.tenantId, async () => {
      const maker = await app
        .get(UsersRepository)
        .inTenant(team.editor.id, team.tenantId);
      const key = attachmentKey(maker!, '.pdf');
      const bytes = Buffer.from('%PDF-1.4 issued');
      await app.get(StorageDisk).put(key, bytes, {
        contentType: 'application/pdf',
      });
      return app.get(AttachmentsService).attachStored(
        maker!,
        { subject: 'TestItem', recordId: item.id },
        {
          key,
          name: 'issued.pdf',
          size: bytes.length,
          contentType: 'application/pdf',
        },
        { locked: true, fields: ['title', 'body'] },
      );
    });
    const link = async (fields: string[]) =>
      (
        await share(team.editor.headers, item.id, {
          fields,
          files: true,
          expiresAt: inDays(1),
        })
      ).json<{ token: string }>().token;
    const covering = await link(['title', 'body']);
    const partial = await link(['title']);

    expect((await open(covering)).json()).toMatchObject({
      files: [{ id: issued.id, name: 'issued.pdf' }],
    });
    expect((await open(partial)).json()).toMatchObject({ files: [] });
    const download = (token: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/shared/files/${issued.id}`,
        payload: { token },
      });
    expect((await download(covering)).statusCode).toBe(200);
    expect((await download(partial)).statusCode).toBe(404);
  });
});
