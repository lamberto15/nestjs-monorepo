import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import {
  createTestItem,
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
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { FeaturesModule } from '../features/features.module.js';
import { SearchModule } from '../search/search.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AttachmentsModule } from './attachments.module.js';
import { AttachmentSearch } from './attachments.search.js';
import { AttachmentTextRetryJob } from './attachments.text.js';
import { attachments } from './attachments.tables.js';
import { attachmentTexts } from './attachments.texts.tables.js';

// Read when the module loads: uploads get their text extracted.
vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    ATTACHMENT_TEXT_SEARCH: 'on',
    REDIS_PREFIX: `test-attachments-text-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

describe('search inside attachments (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let editor: Member;
  let viewer: Member;
  let nobody: Member;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      StorageModule,
      SearchModule,
      FeaturesModule,
      testItemsModule({ imports: [AttachmentsModule.forRecord(TEST_ITEM)] }),
    );
    ({ tenantId, editor, viewer, nobody } = await recordsTenant(app));
  });
  afterAll(async () => {
    await app?.close();
  });

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);

  /** The attachment's text row, once its job has run. */
  const extracted = (attachmentId: string) =>
    vi.waitFor(
      async () => {
        const [row] = await inTenant(() =>
          db()
            .select()
            .from(attachmentTexts)
            .where(eq(attachmentTexts.attachmentId, attachmentId)),
        );
        expect(row).toBeDefined();
        return row!;
      },
      { timeout: 30_000, interval: 200 },
    );

  async function upload(content: string, name: string) {
    const item = await createTestItem(app, editor.headers);
    const boundary = `----t${randomUUID()}`;
    const response = await app.inject({
      method: 'POST',
      url: `/v1/test-items/${item.id}/attachments`,
      headers: {
        ...editor.headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${name.endsWith('.pdf') ? 'application/pdf' : 'text/plain'}\r\n\r\n`,
        ),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(response.statusCode, response.body).toBe(201);
    return { item, added: response.json<{ id: string }>() };
  }

  /** What the global search would add for `headers`' member: the file hits. */
  const files = async (member: Member, q: string) => {
    return inTenant(async () => {
      const principal = await app
        .get(UsersRepository)
        .inTenant(member.id, tenantId);
      return app.get(AttachmentSearch).search(principal!, q, { limit: 20 });
    });
  };

  it('finds a file by a word inside it, only for who may read its record now', async () => {
    const { item, added } = await upload(
      'The lease has a zebraquartz clause on page two.',
      'lease.txt',
    );
    expect(await extracted(added.id)).toMatchObject({ status: 'ready' });

    expect(await files(editor, 'zebraquartz')).toEqual([
      expect.objectContaining({
        subject: 'Attachment',
        id: added.id,
        title: 'lease.txt',
        link: `/test-items/${item.id}`,
        snippet: expect.stringContaining('<b>zebraquartz</b>'),
      }),
    ]);
    expect(await files(viewer, 'zebraquartz')).toHaveLength(1);
    expect(await files(editor, 'nothingthere')).toEqual([]);

    // In the recycle bin, its files are out of the search too.
    const trashed = await app.inject({
      method: 'DELETE',
      url: `/v1/test-items/${item.id}`,
      headers: editor.headers,
    });
    expect(trashed.statusCode).toBe(204);
    expect(await files(editor, 'zebraquartz')).toEqual([]);
  });

  it('matches only the current file, extracts a replaced one again, and drops the text with the attachment', async () => {
    const { added } = await upload('An old ocelotprism memo.', 'memo.txt');
    await extracted(added.id);
    expect(await files(editor, 'ocelotprism')).toHaveLength(1);

    // A new file of the attachment: the old text no longer matches.
    const [row] = await inTenant(() =>
      db().select().from(attachments).where(eq(attachments.id, added.id)),
    );
    const key = `${row!.key}.v2`;
    await app.get(StorageDisk).put(key, Buffer.from('A new lynxharbor memo.'), {
      contentType: row!.contentType,
    });
    await inTenant(() =>
      db()
        .update(attachments)
        .set({ key, updatedAt: new Date(Date.now() - 10 * 60 * 1000) })
        .where(eq(attachments.id, added.id)),
    );
    expect(await files(editor, 'ocelotprism')).toEqual([]);

    // The retry job finds it without text for its file, and queues it.
    expect(
      await app.get(AttachmentTextRetryJob).run(new Date()),
    ).toBeGreaterThanOrEqual(1);
    await vi.waitFor(
      async () => expect(await files(editor, 'lynxharbor')).toHaveLength(1),
      {
        timeout: 30_000,
        interval: 200,
      },
    );

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/attachments/${added.id}`,
      headers: editor.headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      await inTenant(() =>
        db()
          .select()
          .from(attachmentTexts)
          .where(eq(attachmentTexts.attachmentId, added.id)),
      ),
    ).toEqual([]);
  });

  it('adds file hits to GET /v1/search for who may read the record, and honours ?subject=', async () => {
    const { item } = await upload('A quokkaravine clause.', 'terms.txt');
    const search = async (member: Member, query: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/search?q=${query}`,
        headers: member.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ items: { subject: string; link: string }[] }>()
        .items;
    };
    const asked = `quokkaravine`;
    await vi.waitFor(
      async () =>
        expect(await search(viewer, asked)).toEqual([
          expect.objectContaining({
            subject: 'Attachment',
            link: `/test-items/${item.id}`,
          }),
        ]),
      { timeout: 30_000, interval: 200 },
    );
    expect(await search(nobody, asked)).toEqual([]);
    expect(await search(viewer, `${asked}&subject=TestItem`)).toEqual([]);
    expect(await search(viewer, `${asked}&subject=Attachment`)).toHaveLength(1);
  });

  it('says in GET /v1/features that direct uploads are off on this driver', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/features',
      headers: editor.headers,
    });
    expect(response.json()).toMatchObject({ presignedUploads: false });
  });

  it('stores a file the extractor refuses as failed, without text', async () => {
    const { added } = await upload('%PDF-1.4 nothing else', 'broken.pdf');
    expect(await extracted(added.id)).toMatchObject({
      status: 'failed',
      text: '',
    });
  });
});
