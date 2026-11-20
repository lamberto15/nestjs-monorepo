import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { readXlsx } from 'turbosheet';
import { member } from '../../../test/access.js';
import { accessTokenFor } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  unitWithLead,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { SharedLocksModule } from '../../core/locks/locks.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { userRoles } from '../../iam/access/access.tables.js';
import { AccessService } from '../../iam/access/access.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { PeopleModule } from '../people/people.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { TestStagesModule } from '../../../test/fixtures/stages/test-stages.module.js';
import { DataTransferModule } from './data-transfer.module.js';
import {
  dataExportReady,
  dataFailed,
  dataImportFinished,
  dataProgress,
} from './data-transfer.events.js';
import { DATA_TRANSFERS, transferKey } from './data-transfer.service.js';
import { TransferFilesSweep } from './transfer-files.sweep.js';
import { TRANSFER_KEPT_MS } from './transfer-retention.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    IMPORT_MAX_ROWS: '20',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-data-transfer-${process.pid}-${Date.now()}`,
  });
});

/** The path and query of a signed URL: the tests reach the app without a port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/** A multipart body: the text fields, then the file. */
function multipart(
  fields: Record<string, string>,
  file: { bytes: Buffer | string; name: string; type: string },
) {
  const boundary = `----test${randomUUID()}`;
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  const payload = Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    Buffer.from(file.bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

type Transfer = {
  id: string;
  status: string;
  error?: string;
  result?: {
    rows: number;
    url?: string;
    imported?: number;
    failed?: number;
    errorsUrl?: string;
  };
};

describe('data transfer (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      StorageModule,
      SharedLocksModule,
      // Names the owners in exports (@ActorNameSource()).
      PeopleModule,
      testItemsModule({ imports: [DataTransferModule.forRecord(TEST_ITEM)] }),
      // Codes unique within their test item: files name them by a path.
      TestStagesModule,
    );
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    await app
      ?.get<Queue>(getQueueToken(DATA_TRANSFERS))
      .obliterate({ force: true });
    await app?.close();
  });

  const get = (url: string, headers: Headers = team.editor.headers) =>
    app.inject({ method: 'GET', url, headers });

  /** Waits until the transfer ended, as its owner sees it. */
  async function settled(id: string, headers: Headers = team.editor.headers) {
    for (let tries = 0; tries < 400; tries++) {
      const transfer = (
        await get(`/v1/data/transfers/${id}`, headers)
      ).json<Transfer>();
      if (['completed', 'failed'].includes(transfer.status)) return transfer;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Transfer ${id} did not end`);
  }

  const exportOf = async (payload: object, headers = team.editor.headers) => {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/data/exports',
      headers,
      payload: { name: 'test-items', ...payload },
    });
    expect(started.statusCode).toBe(202);
    return settled(started.json<{ id: string }>().id, headers);
  };

  const importOf = async (
    csv: string,
    fields: Record<string, string> = {},
    headers = team.editor.headers,
  ) => {
    const body = multipart(
      { name: 'test-items', ...fields },
      { bytes: csv, name: 'items.csv', type: 'text/csv' },
    );
    return app.inject({
      method: 'POST',
      url: '/v1/data/imports',
      headers: { ...headers, ...body.headers },
      payload: body.payload,
    });
  };

  const titles = async (headers = team.editor.headers) =>
    (await get('/v1/test-items?limit=100', headers))
      .json<{ items: { title: string }[] }>()
      .items.map((item) => item.title)
      .sort();

  it('lists what the caller may export and import', async () => {
    const catalog = (await get('/v1/data')).json<{
      exports: { name: string; columns: string[] }[];
      imports: {
        name: string;
        matchKeys: string[];
        columns: { name: string }[];
      }[];
    }>();
    // The test stages are there too (one test below).
    const items = catalog.exports.find((e) => e.name === 'test-items');
    expect(items).toMatchObject({ name: 'test-items', subject: 'TestItem' });
    expect(items!.columns).toEqual(
      expect.arrayContaining(['id', 'title', 'status', 'owner', 'createdAt']),
    );
    const imports = catalog.imports.find((i) => i.name === 'test-items');
    expect(imports).toMatchObject({ matchKeys: ['id', 'code'] });
    // A read-only field is no import column.
    expect(imports!.columns.map((c) => c.name)).not.toContain('words');

    const none = (await get('/v1/data', team.nobody.headers)).json<{
      exports: unknown[];
      imports: unknown[];
    }>();
    expect(none).toMatchObject({ exports: [], imports: [] });
  });

  it('exports what the list shows the caller, as CSV and Excel, to its owner only', async () => {
    await createTestItem(app, team.editor.headers, {
      title: 'Alpha',
      status: 'done',
    });
    await createTestItem(app, team.editor.headers, { title: 'Beta' });
    await createTestItem(app, team.other.headers, { title: 'Not mine' });

    const csv = await exportOf({ format: 'csv', sort: 'title' });
    expect(csv).toMatchObject({ status: 'completed', result: { rows: 2 } });
    const file = await app.inject({
      method: 'GET',
      url: local(csv.result!.url!),
    });
    expect(file.statusCode).toBe(200);
    const lines = file.body
      .replace(/^\u{feff}/u, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toMatch(/^id,title,body,publishedAt \(UTC\),code,status,/);
    expect(lines.slice(1).map((line) => line.split(',')[1])).toEqual([
      'Alpha',
      'Beta',
    ]);

    // Filtered as the list route filters.
    const done = await exportOf({ filters: { status: 'done' } });
    expect(done.result!.rows).toBe(1);

    const xlsx = await exportOf({ format: 'xlsx' });
    const workbook = readXlsx(
      (await app.inject({ method: 'GET', url: local(xlsx.result!.url!) }))
        .rawPayload,
    );
    expect(workbook.worksheets[0]!.rowCount).toBe(3);

    // Another person's transfer is not found; the owner's list has it.
    expect(
      (await get(`/v1/data/transfers/${csv.id}`, team.other.headers))
        .statusCode,
    ).toBe(404);
    const mine = (await get('/v1/data/transfers?kind=export')).json<{
      items: { id: string }[];
    }>();
    expect(mine.items.map((item) => item.id)).toContain(csv.id);
  });

  it('refuses an export it cannot run, naming the filter', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/data/exports',
      headers: team.editor.headers,
      payload: { name: 'test-items', filters: { status: 'nope' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ errors: { path: string }[] }>().errors[0]!.path).toMatch(
      /^filters\./,
    );
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/data/exports',
      headers: team.editor.headers,
      payload: { name: 'nothing' },
    });
    expect(unknown.statusCode).toBe(404);
    const nobody = await app.inject({
      method: 'POST',
      url: '/v1/data/exports',
      headers: team.nobody.headers,
      payload: { name: 'test-items' },
    });
    expect(nobody.statusCode).toBe(403);
  });

  it('checks every row in a dry run, then writes the valid ones, with a report of the others', async () => {
    const csv = 'title,status\nImported one,done\n,draft\nImported two,bogus\n';
    const dry = await importOf(csv, { dryRun: 'true' });
    expect(dry.statusCode).toBe(202);
    const checked = await settled(dry.json<{ id: string }>().id);
    expect(checked.result).toMatchObject({ rows: 3, imported: 1, failed: 2 });
    expect(await titles()).not.toContain('Imported one');

    const errors = await app.inject({
      method: 'GET',
      url: local(checked.result!.errorsUrl!),
    });
    expect(errors.body).toMatch(/^\u{feff}?row,field,message\r\n2,title,/u);
    expect(errors.body).toMatch(/\r\n3,status,/);

    const real = await settled((await importOf(csv)).json<{ id: string }>().id);
    expect(real.result).toMatchObject({ imported: 1, failed: 2 });
    expect(await titles()).toContain('Imported one');
  });

  it('maps the file headers to the columns, and saves a mapping', async () => {
    const mapping = JSON.stringify({ Name: 'title', Internal: null });
    const done = await settled(
      (await importOf('Name,Internal\nMapped,x\n', { mapping })).json<{
        id: string;
      }>().id,
    );
    expect(done.result).toMatchObject({ imported: 1, failed: 0 });
    expect(await titles()).toContain('Mapped');

    // A target that is no column is refused before any work.
    expect(
      (
        await importOf('Name\nX\n', {
          mapping: JSON.stringify({ Name: 'words' }),
        })
      ).statusCode,
    ).toBe(400);

    const url = '/v1/data/imports/test-items/mappings';
    const saved = await app.inject({
      method: 'POST',
      url,
      headers: team.editor.headers,
      payload: { name: 'CRM', mapping: { Name: 'title' } },
    });
    expect(saved.statusCode).toBe(201);
    const again = await app.inject({
      method: 'POST',
      url,
      headers: team.other.headers,
      payload: { name: 'crm', mapping: { Name: 'title' } },
    });
    expect(again.statusCode).toBe(409);
    expect(
      (await get(url)).json<{ items: { name: string; stale: string[] }[] }>()
        .items,
    ).toEqual([expect.objectContaining({ name: 'CRM', stale: [] })]);
    expect((await get(url, team.nobody.headers)).statusCode).toBe(404);
    const removed = await app.inject({
      method: 'DELETE',
      url: `${url}/${saved.json<{ id: string }>().id}`,
      headers: team.editor.headers,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('updates the record a match key finds, refusing keys it does not find', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Before',
      code: `C-${randomUUID().slice(0, 6)}`,
    });
    const code = item.code as string;
    const done = await settled(
      (
        await importOf(
          `code,title\n${code},After\nmissing,Other\n${code},Twice\n`,
          {
            matchOn: 'code',
          },
        )
      ).json<{ id: string }>().id,
    );
    expect(done.result).toMatchObject({ rows: 3, imported: 1, failed: 2 });
    const read = (await get(`/v1/test-items/${item.id}`)).json<{
      title: string;
    }>();
    expect(read.title).toBe('After');
    // Someone else's record is not found by its key.
    const theirs = await settled(
      (
        await importOf(
          `code,title\n${code},Taken\n`,
          { matchOn: 'code' },
          team.other.headers,
        )
      ).json<{ id: string }>().id,
      team.other.headers,
    );
    expect(theirs.result).toMatchObject({ imported: 0, failed: 1 });
  });

  it("names a reference by its record's key: written in exports, taken in imports", async () => {
    const suffix = randomUUID().slice(0, 6);
    const parent = await createTestItem(app, team.editor.headers, {
      title: `Parent ${suffix}`,
      code: `P-${suffix}`,
    });
    const child = await createTestItem(app, team.editor.headers, {
      title: `Child ${suffix}`,
      parentId: parent.id,
    });
    await createTestItem(app, team.other.headers, {
      title: `Theirs ${suffix}`,
      code: `O-${suffix}`,
    });

    const csv = await exportOf({ format: 'csv' });
    const [header, ...rows] = (
      await app.inject({ method: 'GET', url: local(csv.result!.url!) })
    ).body
      .replace(/^\u{feff}/u, '')
      .trim()
      .split('\r\n')
      .map((line) => line.split(','));
    const at = header!.indexOf('parentId');
    const written = rows.find((row) => row[0] === child.id)!;
    expect(written[at]).toBe(`P-${suffix}`);

    const done = await settled(
      (
        await importOf(
          `title,parentId\n` +
            `By key ${suffix},P-${suffix}\n` +
            `By id ${suffix},${parent.id as string}\n` +
            `Unknown ${suffix},NOPE-${suffix}\n` +
            // Someone else's record is not found by its key either.
            `Not readable ${suffix},O-${suffix}\n`,
        )
      ).json<{ id: string }>().id,
    );
    expect(done.result).toMatchObject({ rows: 4, imported: 2, failed: 2 });
    const children = (
      await get(`/v1/test-items?parentId=${parent.id as string}&limit=100`)
    ).json<{ items: { title: string }[] }>();
    expect(children.items.map((item) => item.title).sort()).toEqual([
      `By id ${suffix}`,
      `By key ${suffix}`,
      `Child ${suffix}`,
    ]);
    const report = (
      await app.inject({ method: 'GET', url: local(done.result!.errorsUrl!) })
    ).body;
    // CSV doubles the quotes.
    expect(report).toContain(
      `3,parentId,"No test item whose code is ""NOPE-${suffix}""."`,
    );
    expect(report).toContain(`4,parentId,`);
  });

  it("names a record whose code is unique within its parent by a path of keys: the parent's, then its own", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { headers } = team.admin;
    for (const code of [`P-${suffix}`, `Q-${suffix}`]) {
      await createTestItem(app, headers, { title: code, code });
    }
    const stages = async (csv: string) =>
      (
        await settled(
          (await importOf(csv, { name: 'test-stages' }, headers)).json<{
            id: string;
          }>().id,
          headers,
        )
      ).result!;
    // The same code under two items: each item's own.
    expect(
      await stages(`itemId,code\nP-${suffix},OPEN\nQ-${suffix},OPEN\n`),
    ).toMatchObject({ imported: 2, failed: 0 });
    const done = await stages(
      `itemId,code,nextId\n` +
        `P-${suffix},DONE,P-${suffix}/OPEN\n` +
        `P-${suffix},LATE,Q-${suffix}/NOPE\n` +
        // The code alone names no stage: there are two OPEN.
        `P-${suffix},SOON,OPEN\n`,
    );
    expect(done).toMatchObject({ rows: 3, imported: 1, failed: 2 });
    const report = (
      await app.inject({ method: 'GET', url: local(done.errorsUrl!) })
    ).body;
    expect(report).toContain(
      `2,nextId,"No test stage whose test item code/code is ""Q-${suffix}/NOPE""."`,
    );
    expect(report).toContain(`3,nextId,`);

    const started = await app.inject({
      method: 'POST',
      url: '/v1/data/exports',
      headers,
      payload: { name: 'test-stages', format: 'csv' },
    });
    expect(started.statusCode, started.body).toBe(202);
    const csv = await settled(started.json<{ id: string }>().id, headers);
    const [header, ...rows] = (
      await app.inject({ method: 'GET', url: local(csv.result!.url!) })
    ).body
      .replace(/^\u{feff}/u, '')
      .trim()
      .split('\r\n')
      .map((line) => line.split(','));
    const at = (name: string) => header!.indexOf(name);
    const written = rows.find((row) => row[at('code')] === 'DONE')!;
    expect(written[at('itemId')]).toBe(`P-${suffix}`);
    expect(written[at('nextId')]).toBe(`P-${suffix}/OPEN`);
  });

  it("takes a person field by a member's email or name, writes their name, and refuses one who is no member", async () => {
    const suffix = randomUUID().slice(0, 6);
    const { headers } = team.admin;
    const assignee = await member(app, team.tenantId, [], {
      email: `assignee-${suffix}@acme.dev`,
      name: `Assignee ${suffix}`,
    });
    const item = `A-${suffix}`;
    await createTestItem(app, headers, { title: item, code: item });
    const run = async (csv: string) => {
      const done = await settled(
        (await importOf(csv, { name: 'test-stages' }, headers)).json<{
          id: string;
        }>().id,
        headers,
      );
      const report = done.result!.errorsUrl
        ? (
            await app.inject({
              method: 'GET',
              url: local(done.result!.errorsUrl),
            })
          ).body
        : '';
      return { result: done.result!, report };
    };
    const { result, report } = await run(
      `itemId,code,assigneeId\n` +
        `${item},BY-EMAIL,ASSIGNEE-${suffix}@ACME.DEV\n` +
        `${item},BY-NAME,Assignee ${suffix}\n` +
        `${item},BY-KEY,user:${assignee.id}\n` +
        `${item},NOBODY,nobody-${suffix}@acme.dev\n` +
        `${item},STRANGER,user:${randomUUID()}\n`,
    );
    expect(result).toMatchObject({ rows: 5, imported: 3, failed: 2 });
    expect(report).toContain(
      `4,assigneeId,"No member whose email or name is ""nobody-${suffix}@acme.dev""`,
    );
    // A key that is no member's: the record's own write refuses it.
    expect(report).toMatch(/5,assigneeId,.*is no member of this tenant/);

    const started = await app.inject({
      method: 'POST',
      url: '/v1/data/exports',
      headers,
      payload: { name: 'test-stages', format: 'csv' },
    });
    const csv = await settled(started.json<{ id: string }>().id, headers);
    const [header, ...rows] = (
      await app.inject({ method: 'GET', url: local(csv.result!.url!) })
    ).body
      .replace(/^\u{feff}/u, '')
      .trim()
      .split('\r\n')
      .map((line) => line.split(','));
    const at = (name: string) => header!.indexOf(name);
    const mine = rows.filter((row) => row[at('itemId')] === item);
    // Lists name and filter it as they do the owner: a person's key.
    const described = (await get('/v1/lists/TestStage', headers)).json<{
      fields: { name: string; ref?: string }[];
    }>();
    expect(described.fields.find((f) => f.name === 'assigneeId')).toMatchObject(
      {
        ref: 'principal',
      },
    );
    expect(mine.map((row) => row[at('assigneeId')])).toEqual([
      `Assignee ${suffix}`,
      `Assignee ${suffix}`,
      `Assignee ${suffix}`,
    ]);
  });

  it('names the owner and the unit in an export, not their ids', async () => {
    const { unitId, worker } = await unitWithLead(app, team);
    const item = await createTestItem(app, worker.headers, { title: 'Owned' });
    const csv = await exportOf({ format: 'csv' }, worker.headers);
    const [header, ...rows] = (
      await app.inject({ method: 'GET', url: local(csv.result!.url!) })
    ).body
      .replace(/^\u{feff}/u, '')
      .trim()
      .split('\r\n')
      .map((line) => line.split(','));
    const row = rows.find((cells) => cells[0] === item.id)!;
    expect(row[header!.indexOf('owner')]).toBe('Test User');
    // unitWithLead names its team `Team <6 characters>`.
    expect(row[header!.indexOf('unit')]).toMatch(/^Team \S{6}$/);
    expect(row[header!.indexOf('unit')]).not.toBe(unitId);
  });

  it('stops an import past the row limit, and refuses what it cannot read', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => `Row ${i}`).join('\n');
    const tooMany = await settled(
      (await importOf(`title\n${rows}\n`)).json<{ id: string }>().id,
    );
    expect(tooMany).toMatchObject({ status: 'failed' });
    expect(tooMany.error).toMatch(/row limit/);

    const body = multipart(
      { name: 'test-items' },
      {
        bytes: Buffer.from([0, 1, 2, 3, 255]),
        name: 'x.bin',
        type: 'application/octet-stream',
      },
    );
    const binary = await app.inject({
      method: 'POST',
      url: '/v1/data/imports',
      headers: { ...team.editor.headers, ...body.headers },
      payload: body.payload,
    });
    expect(binary.statusCode).toBeGreaterThanOrEqual(400);
    expect(binary.statusCode).toBeLessThan(500);
  });

  it('gives a template to fill', async () => {
    const template = await get(
      '/v1/data/imports/test-items/template?format=csv&timezone=Asia/Manila',
    );
    expect(template.statusCode).toBe(200);
    expect(template.headers['content-disposition']).toMatch(
      /test-items-template\.csv/,
    );
    expect(template.body.replace(/^\u{feff}/u, '').split('\r\n')[0]).toMatch(
      /^title,body,publishedAt \(Asia\/Manila\),code,status/,
    );
    expect(
      (await get('/v1/data/imports/test-items/template', team.nobody.headers))
        .statusCode,
    ).toBe(404);
  });

  it('tells the starter live: export ready, progress, import finished, failed', async () => {
    const push = vi.spyOn(app.get(Realtime), 'toPrincipal');
    await createTestItem(app, team.editor.headers, { title: 'Live' });
    const exported = await exportOf({ format: 'csv' });
    expect(push).toHaveBeenCalledWith(
      expect.anything(),
      dataExportReady,
      expect.objectContaining({
        id: exported.id,
        name: 'test-items',
        rows: exported.result!.rows,
        url: expect.any(String),
      }),
    );
    expect(push).toHaveBeenCalledWith(
      expect.anything(),
      dataProgress,
      expect.objectContaining({ id: exported.id, kind: 'export' }),
    );

    const imported = await settled(
      (await importOf('title\nLive import\n')).json<{ id: string }>().id,
    );
    expect(push).toHaveBeenCalledWith(expect.anything(), dataImportFinished, {
      id: imported.id,
      name: 'test-items',
      rows: 1,
      imported: 1,
      failed: 0,
    });

    const failed = await settled(
      (await importOf('title\nX\n', { matchOn: 'code' })).json<{
        id: string;
      }>().id,
    );
    expect(failed.status).toBe('failed');
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        expect.anything(),
        dataFailed,
        expect.objectContaining({
          id: failed.id,
          kind: 'import',
          error: expect.stringContaining('match column'),
        }),
      ),
    );
    push.mockRestore();
  });

  /** The transfer as its detail and its list item tell it. */
  async function shown(id: string, headers: Headers) {
    const detail = (await get(`/v1/data/transfers/${id}`, headers)).json<
      Transfer & { expiresAt: string }
    >();
    const listed = (await get('/v1/data/transfers?kind=export', headers))
      .json<{ items: Transfer[] }>()
      .items.find((item) => item.id === id);
    return { detail, listed };
  }

  it('gives no link to a starter who lost the right to read the record, and keeps the transfer', async () => {
    const reader = await member(app, team.tenantId, ['viewer']);
    await createTestItem(app, team.editor.headers, { title: 'Readable' });
    const exported = await exportOf({ format: 'csv' }, reader.headers);
    expect(exported.result!.url).toEqual(expect.any(String));

    await app
      .get(Tenancy)
      .run(team.tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .delete(userRoles)
          .where(eq(userRoles.userId, reader.id)),
      );
    app.get(AccessService).invalidate();

    const { detail, listed } = await shown(exported.id, reader.headers);
    for (const transfer of [detail, listed]) {
      expect(transfer).toMatchObject({
        id: exported.id,
        status: 'completed',
        result: { rows: exported.result!.rows },
      });
      expect(transfer!.result).not.toHaveProperty('url');
    }
  });

  it('gives no link once the transfer has expired, and never one that outlives it', async () => {
    await createTestItem(app, team.editor.headers, { title: 'Expiring' });
    const exported = await exportOf({ format: 'csv' });
    const { detail } = await shown(exported.id, team.editor.headers);
    const expiresAt = Date.parse(detail.expiresAt);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // A minute before it ends: a link, signed for that minute only.
      vi.setSystemTime(expiresAt - 60_000);
      const { headers } = await accessTokenFor(
        app,
        team.editor.id,
        team.tenantId,
      );
      const late = (await shown(exported.id, headers)).detail;
      const signedUntil = Number(
        new URL(late.result!.url!).searchParams.get('expires'),
      );
      expect(signedUntil * 1000).toBeLessThanOrEqual(expiresAt);

      vi.setSystemTime(expiresAt + 1);
      const fresh = await accessTokenFor(app, team.editor.id, team.tenantId);
      const { detail: gone, listed } = await shown(exported.id, fresh.headers);
      for (const transfer of [gone, listed]) {
        expect(transfer).toMatchObject({
          status: 'completed',
          result: { rows: exported.result!.rows },
        });
        expect(transfer!.result).not.toHaveProperty('url');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes the tenant's transfer files past their retention, and nothing else", async () => {
    const disk = app.get(StorageDisk);
    const old = transferKey(team.tenantId, 'old.csv');
    const other = `tenants/${team.tenantId}/attachments/old.bin`;
    const fresh = transferKey(team.tenantId, 'fresh.csv');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() - TRANSFER_KEPT_MS - 60_000);
      await disk.put(old, 'old');
      await disk.put(other, 'not a transfer');
    } finally {
      vi.useRealTimers();
    }
    await disk.put(fresh, 'fresh');

    expect(await app.get(TransferFilesSweep).run()).toBeGreaterThanOrEqual(1);
    expect(await disk.exists(old)).toBe(false);
    expect(await disk.exists(fresh)).toBe(true);
    expect(await disk.exists(other)).toBe(true);
  });
});
