import { randomUUID } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import { and, eq } from 'drizzle-orm';
import { member } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItems } from '../../../test/fixtures/test-items/test-items.tables.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { SharedHttpClientModule } from '../../core/http-client/http-client.module.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import {
  RECYCLE_BIN_PURGE,
  RecycleBinPurgeJob,
} from '../records/recycle-bin.job.js';
import { Records } from '../records/records.service.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { DocumentClaimLost, DocumentsService } from './documents.service.js';
import { DocumentsModule } from './documents.module.js';
import { documents } from './documents.tables.js';

/**
 * A stand-in for Gotenberg on loopback (no Docker pull, no Chromium),
 * started before the app loads: this file's app renders through it
 * (GOTENBERG_URL). It records each page it is sent, and answers each
 * request as the next of `state.answers` says (`ok` once they run out): a
 * PDF, a refusal (400), a failure (503), nothing at all (`hang`, until the
 * client gives up), or a PDF after 250 ms (`slow`).
 */
const gotenberg = await vi.hoisted(async () => {
  const { createServer } = await import('node:http');
  const { randomUUID: uuid } = await import('node:crypto');
  type Answer = 'ok' | 'reject' | 'down' | 'hang' | 'slow';
  const state = { answers: [] as Answer[] };
  const pages: { html: string; trace: string | undefined; path: string }[] = [];
  const pdfs: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const form = await new Response(Buffer.concat(chunks), {
          headers: { 'content-type': req.headers['content-type'] ?? '' },
        }).formData();
        const file = form.get('files') as File;
        pages.push({
          html: await file.text(),
          trace: req.headers['gotenberg-trace'] as string | undefined,
          path: req.url ?? '',
        });
        const answer = state.answers.shift() ?? 'ok';
        if (answer === 'hang') return; // answered when the server closes
        if (answer === 'reject') {
          res.writeHead(400).end('Invalid form data');
          return;
        }
        if (answer === 'down') {
          res.writeHead(503).end('Chromium crashed');
          return;
        }
        if (answer === 'slow') {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const pdf = Buffer.from(`%PDF-1.7\n% stub ${uuid()}\n%%EOF\n`);
        pdfs.push(pdf);
        res.writeHead(200, { 'content-type': 'application/pdf' }).end(pdf);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    ADMIN_PASSWORD: 'correct horse battery staple',
    ADMIN_ONBOARDING: 'off',
    REDIS_PREFIX: `test-documents-${process.pid}-${Date.now()}`,
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    APP_ROLE: 'all',
    GOTENBERG_URL: `http://127.0.0.1:${port}`,
    // Short, so the timeout tests wait a moment, not 30 s; long enough for
    // a `slow` answer on a busy machine.
    GOTENBERG_TIMEOUT_MS: '1500',
    DOCUMENTS_RENDER_ATTEMPTS: '2',
  });
  return {
    state,
    pages,
    pdfs,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
});

/** The path and query of a signed URL: the tests reach the app without a port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('documents (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      SharedHttpClientModule,
      StorageModule,
      testItemsModule({
        imports: [
          DocumentsModule.forRecord(TEST_ITEM),
          AttachmentsModule.forRecord(TEST_ITEM),
        ],
      }),
    );
    db = app.get<Database>(getDrizzleToken());
    team = await recordsTenant(app);
  });
  beforeEach(() => {
    gotenberg.state.answers.length = 0;
    gotenberg.pages.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await gotenberg.close();
  });

  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(team.tenantId, work);

  const ask = (headers: Headers, recordId: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/test-items/${recordId}/pdf`,
      headers: { ...headers, 'idempotency-key': randomUUID() },
    });

  /** The page Gotenberg was sent for a document (traced by its id). */
  const pageOf = (id: string) =>
    gotenberg.pages.find((page) => page.trace === id)?.html;

  const status = (headers: Headers, id: string) =>
    app.inject({ method: 'GET', url: `/v1/documents/${id}`, headers });

  /** Polls a document until a worker finished it. */
  async function done(headers: Headers, id: string) {
    for (let i = 0; i < 200; i++) {
      const document = (await status(headers, id)).json();
      if (document.status === 'completed' || document.status === 'failed') {
        return document;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The document did not finish');
  }

  /** The PDFs on the disk for a document (one key per run). */
  const files = async (id: string) =>
    (
      await app
        .get(StorageDisk)
        .list({ prefix: `tenants/${team.tenantId}/documents/${id}/` })
    ).entries.map((entry) => entry.key);

  const link = (headers: Headers, id: string) =>
    app.inject({
      method: 'GET',
      url: `/v1/documents/${id}/download`,
      headers,
    });

  /** Follows the signed link of a document's download. */
  const download = async (headers: Headers, id: string) => {
    const redirect = await link(headers, id);
    expect(redirect.statusCode).toBe(302);
    return app.inject({
      method: 'GET',
      url: local(redirect.headers.location!),
    });
  };

  it('renders a record on a worker, stores the PDF on the disk, and lets the reader download it', async () => {
    const record = await createTestItem(app, team.editor.headers, {
      title: 'Quarterly report',
      body: 'All good.',
    });
    const asked = await ask(team.editor.headers, record.id);
    expect(asked.statusCode).toBe(202);
    expect(asked.json()).toEqual({ id: expect.any(String), status: 'queued' });

    const issued = await done(team.editor.headers, asked.json().id);
    expect(issued).toMatchObject({
      status: 'completed',
      source: 'test-items',
      subject: 'TestItem',
      recordId: record.id,
      locale: 'en',
      fileName: 'Quarterly report.pdf',
      error: null,
    });
    // The page sent to Gotenberg is the template filled with the record, traced by the document's id.
    const page = pageOf(asked.json().id);
    expect(gotenberg.pages[0]!.path).toBe('/forms/chromium/convert/html');
    expect(page).toContain('Quarterly report');
    expect(page).toContain('All good.');
    expect(page).toContain('<html lang="en" dir="ltr">');
    expect(await files(asked.json().id)).toHaveLength(1);

    const pdf = await download(team.editor.headers, asked.json().id);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.equals(gotenberg.pdfs[0]!)).toBe(true);
    const inline = await app.inject({
      method: 'GET',
      url: `/v1/documents/${asked.json().id}/download?inline=true`,
      headers: team.editor.headers,
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: local(inline.headers.location!),
        })
      ).headers['content-disposition'],
    ).toMatch(/^inline/);

    const actions = (
      await inTenant(() =>
        db
          .select({ action: auditLog.action })
          .from(auditLog)
          .where(eq(auditLog.targetId, asked.json().id)),
      )
    ).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['document.requested', 'document.issued']),
    );

    // The record's documents, newest first, and its list's description.
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/test-items/${record.id}/documents`,
      headers: team.editor.headers,
    });
    expect(listed.json().items[0]).toMatchObject({
      id: asked.json().id,
      status: 'completed',
      template: 'pdf-record',
      language: 'en',
      issuedBy: `user:${team.editor.id}`,
      issuedByName: expect.any(String),
    });
    // The PDF is a locked attachment of the record, and carries the tenant's brand.
    const attached = await app.inject({
      method: 'GET',
      url: `/v1/test-items/${record.id}/attachments`,
      headers: team.editor.headers,
    });
    expect(attached.json().items).toEqual([
      expect.objectContaining({
        id: issued.attachmentId,
        name: 'Quarterly report.pdf',
        contentType: 'application/pdf',
        locked: true,
      }),
    ]);
    expect(page).toContain('border-top: 6pt solid #');
    const described = await app.inject({
      method: 'GET',
      url: '/v1/lists/TestItem',
      headers: team.editor.headers,
    });
    expect(described.json().capabilities.pdf).toBe(true);
    expect(described.json().documentTemplates).toEqual([
      { id: 'pdf-record', language: 'en' },
    ]);
  });

  it('is for those who may read the record', async () => {
    const record = await createTestItem(app, team.editor.headers);
    // Another editor reads none of their records.
    expect((await ask(team.other.headers, record.id)).statusCode).toBe(404);
    expect(gotenberg.pages).toHaveLength(0);
    const asked = await ask(team.editor.headers, record.id);
    await done(team.editor.headers, asked.json().id);
    expect((await status(team.other.headers, asked.json().id)).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/test-items/${record.id}/documents`,
          headers: team.other.headers,
        })
      ).statusCode,
    ).toBe(404);
    expect((await link(team.other.headers, asked.json().id)).statusCode).toBe(
      404,
    );
  });

  it('tries a failed render again, then issues it', async () => {
    const record = await createTestItem(app, team.editor.headers);
    gotenberg.state.answers.push('down');
    const asked = await ask(team.editor.headers, record.id);
    const issued = await done(team.editor.headers, asked.json().id);
    expect(issued.status).toBe('completed');
    expect(gotenberg.pages).toHaveLength(2);
    expect(await files(asked.json().id)).toHaveLength(1);
  }, 30_000);

  it('fails without retries when Gotenberg refuses the page', async () => {
    const record = await createTestItem(app, team.editor.headers);
    gotenberg.state.answers.push('reject');
    const asked = await ask(team.editor.headers, record.id);
    const failed = await done(team.editor.headers, asked.json().id);
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'rejected' });
    expect(failed.error).toContain('refused');
    expect(gotenberg.pages).toHaveLength(1);
    expect(await files(asked.json().id)).toEqual([]);
    // Nothing to download.
    expect((await link(team.editor.headers, asked.json().id)).statusCode).toBe(
      404,
    );
  }, 30_000);

  it('gives up after its attempts when Gotenberg never answers (timeouts)', async () => {
    const record = await createTestItem(app, team.editor.headers);
    gotenberg.state.answers.push('hang', 'hang');
    const asked = await ask(team.editor.headers, record.id);
    const failed = await done(team.editor.headers, asked.json().id);
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'unavailable',
    });
    expect(gotenberg.pages).toHaveLength(2);
  }, 60_000);

  it('refuses a second request while the first is rendering (409 document_pending)', async () => {
    const record = await createTestItem(app, team.editor.headers);
    gotenberg.state.answers.push('slow');
    const first = await ask(team.editor.headers, record.id);
    const again = await ask(team.editor.headers, record.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: 'document_pending',
      id: first.json().id,
    });
    await done(team.editor.headers, first.json().id);
    // Done: asking again issues a new document.
    expect((await ask(team.editor.headers, record.id)).statusCode).toBe(202);
  });

  it('a reader without TestItem.body cannot download a PDF that includes it, nor see its document', async () => {
    const record = await createTestItem(app, team.admin.headers, {
      title: 'Salaries',
      body: 'confidential text',
    });
    const asked = await ask(team.admin.headers, record.id);
    await done(team.admin.headers, asked.json().id);
    const [row] = await inTenant(() =>
      db.select().from(documents).where(eq(documents.id, asked.json().id)),
    );
    expect(row!.fields).toContain('body');
    expect(pageOf(asked.json().id)).toContain('confidential text');

    // Every test item, titles only (no TestItem.body).
    const role = await app.inject({
      method: 'POST',
      url: '/v1/access/roles',
      headers: team.admin.headers,
      payload: {
        name: `Titles ${randomUUID().slice(0, 6)}`,
        permissions: [
          { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
        ],
      },
    });
    expect(role.statusCode).toBe(201);
    const reader = await member(app, team.tenantId, [role.json().id]);
    expect((await status(reader.headers, asked.json().id)).statusCode).toBe(
      404,
    );
    expect((await link(reader.headers, asked.json().id)).statusCode).toBe(404);
    // Its attachment stays in the list, as before, but is not read or downloaded.
    const { attachmentId } = (
      await status(team.admin.headers, asked.json().id)
    ).json<{ attachmentId: string }>();
    const listed = async (headers: Record<string, string>) =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/test-items/${record.id}/attachments`,
          headers,
        })
      )
        .json<{ items: { id: string; name: string }[] }>()
        .items.map((file) => file.id);
    const nameIn = async (headers: Record<string, string>, id: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/test-items/${record.id}/attachments`,
          headers,
        })
      )
        .json<{ items: { id: string; name: string }[] }>()
        .items.find((file) => file.id === id)?.name;
    const attachment = (headers: Record<string, string>, path = '') =>
      app.inject({
        method: 'GET',
        url: `/v1/attachments/${attachmentId}${path}`,
        headers,
      });
    expect(await listed(team.admin.headers)).toContain(attachmentId);
    expect(await listed(reader.headers)).toContain(attachmentId);
    // Its name is made from the record's fields: a reader who may not read
    // them all sees a neutral one, whichever field the name came from.
    expect(await nameIn(team.admin.headers, attachmentId)).toBe('Salaries.pdf');
    expect(await nameIn(reader.headers, attachmentId)).toBe('test item.pdf');
    // Nor does a filter or a sort by name match the real one for them.
    const byName = async (headers: Record<string, string>, search: string) =>
      (
        await app.inject({
          method: 'GET',
          url: `/v1/test-items/${record.id}/attachments?${search}`,
          headers,
        })
      )
        .json<{ items: { id: string }[] }>()
        .items.map((file) => file.id);
    expect(await byName(team.admin.headers, 'name.contains=Salar')).toEqual([
      attachmentId,
    ]);
    expect(await byName(reader.headers, 'name.contains=Salar')).toEqual([]);
    expect(await byName(reader.headers, 'sort=name')).not.toContain(
      attachmentId,
    );
    expect((await attachment(team.admin.headers)).statusCode).toBe(200);
    expect((await attachment(reader.headers)).statusCode).toBe(404);
    expect((await attachment(reader.headers, '/download')).statusCode).toBe(
      404,
    );
    expect((await attachment(reader.headers, '/versions')).statusCode).toBe(
      404,
    );
    // Who may read the text downloads it.
    expect(
      (await download(team.admin.headers, asked.json().id)).statusCode,
    ).toBe(200);

    // A PDF without the text (asked for by the titles-only reader) is theirs to read.
    const theirs = await ask(reader.headers, record.id);
    const shown = await done(reader.headers, theirs.json().id);
    expect(shown.status).toBe('completed');
    expect(pageOf(theirs.json().id)).not.toContain('confidential text');
    // Theirs shows only what they may read: its real name.
    const ownAttachment = (
      await status(reader.headers, theirs.json().id)
    ).json<{ attachmentId: string }>().attachmentId;
    expect(await nameIn(reader.headers, ownAttachment)).toBe('Salaries.pdf');
    expect((await download(reader.headers, theirs.json().id)).statusCode).toBe(
      200,
    );
  });

  it('goes with its record: the purge of a record deleted for good removes its documents and files', async () => {
    const record = await createTestItem(app, team.editor.headers);
    const asked = await ask(team.editor.headers, record.id);
    await done(team.editor.headers, asked.json().id);
    expect(await files(asked.json().id)).toHaveLength(1);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/test-items/${record.id}`,
      headers: team.editor.headers,
    });
    expect(deleted.statusCode).toBe(204);
    await inTenant(() =>
      db
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
        .where(eq(testItems.id, record.id)),
    );
    await app.get(RecycleBinPurgeJob).run();

    expect(
      await inTenant(() =>
        db.select().from(documents).where(eq(documents.id, asked.json().id)),
      ),
    ).toEqual([]);
    // After the commit, through the outbox (StoredFiles).
    await vi.waitFor(
      async () => expect(await files(asked.json().id)).toEqual([]),
      { timeout: 10_000 },
    );
  });

  it("keeps a purged record's documents and files when the purge's transaction rolls back", async () => {
    const record = await createTestItem(app, team.editor.headers);
    const asked = await ask(team.editor.headers, record.id);
    await done(team.editor.headers, asked.json().id);
    expect(await files(asked.json().id)).toHaveLength(1);
    const store = app.get(Records).find(TEST_ITEM.subject)!.store;

    await expect(
      inTenant(() =>
        app.get(TransactionHost).withTransaction(async () => {
          await store.forget(RECYCLE_BIN_PURGE, [record.id]);
          throw new Error('a later step fails');
        }),
      ),
    ).rejects.toThrow('a later step fails');

    expect(
      await inTenant(() =>
        db.select().from(documents).where(eq(documents.id, asked.json().id)),
      ),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await files(asked.json().id)).toHaveLength(1);
  });

  describe('a job run twice, and a failure told twice', () => {
    /** A queued document of a record, as a request would leave it. */
    async function queued() {
      const record = await createTestItem(app, team.editor.headers);
      const principal = (await app
        .get(UsersRepository)
        .inTenant(team.editor.id, team.tenantId))!;
      const [row] = await inTenant(() =>
        db
          .insert(documents)
          .values({
            source: 'test-items',
            template: 'pdf-record',
            subject: 'TestItem',
            recordId: record.id,
            locale: 'en',
            timezone: 'UTC',
            status: 'queued',
            requestedBy: `user:${team.editor.id}`,
          })
          .returning(),
      );
      return {
        row: row!,
        principal,
        job: { id: row!.id, principal, tenantId: team.tenantId },
      };
    }

    it('issues one PDF when a document is rendered twice at once (a stalled job run again)', async () => {
      const { row, principal, job } = await queued();
      gotenberg.state.answers.push('slow', 'slow');
      const service = app.get(DocumentsService);
      const run = () =>
        inTenant(() => service.issue(job, principal, { final: true }));
      const results = await Promise.allSettled([run(), run()]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected');
      expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(
        DocumentClaimLost,
      );
      const [issued] = await inTenant(() =>
        db.select().from(documents).where(eq(documents.id, row.id)),
      );
      expect(issued!.status).toBe('completed');
      // The loser deleted its own file: one PDF, the winner's.
      expect(await files(row.id)).toEqual([issued!.fileKey]);
    });

    it('fails a document once: a second fail() changes, audits and tells nothing', async () => {
      const { row, job } = await queued();
      const service = app.get(DocumentsService);
      await inTenant(() => service.fail(job, 'unavailable'));
      await inTenant(() => service.fail(job, 'rejected'));
      const [failed] = await inTenant(() =>
        db.select().from(documents).where(eq(documents.id, row.id)),
      );
      expect(failed).toMatchObject({ status: 'failed', error: 'unavailable' });
      const entries = await inTenant(() =>
        db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.targetId, row.id),
              eq(auditLog.action, 'document.failed'),
            ),
          ),
      );
      expect(entries).toHaveLength(1);
    });
  });
});
