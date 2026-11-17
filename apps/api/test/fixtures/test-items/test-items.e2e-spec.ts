import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { tenantWithAdmin } from '../../access.js';
import { apiClient } from '../../auth.js';
import { bootModules } from '../../boot.js';
import {
  createTestItem,
  type Headers,
  type Member,
  recordsTenant,
  testItemModules,
  unitWithLead,
} from '../../records.js';
import type { Database } from '../../../src/core/database/database.js';
import { Tenancy } from '../../../src/core/tenancy/tenancy.service.js';
import { auditLog } from '../../../src/iam/audit/audit.tables.js';
import { RecycleBinPurgeJob } from '../../../src/modules/records/recycle-bin.job.js';
import { testRecordMarks, testRecordSeen } from './marks/marks.tables.js';
import { testItemsWithMarks } from './test-items.module.js';
import { testItems } from './test-items.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-items-${process.pid}:`;
});

/**
 * The records engine (modules/records) on the test items: the routes a
 * feature declares, what the declaration derives (owner, units, recycle
 * bin, permissions, list, relations), the legal holds and the recycle
 * bin's purge, and the add-on contract proven by marks
 * (test/fixtures/test-items/marks).
 */
describe('records: test items (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Member;
  let editor: Member;
  let other: Member;
  let viewer: Member;
  let nobody: Member;

  beforeAll(async () => {
    app = await bootModules(...testItemModules(), testItemsWithMarks());
    ({ tenantId, admin, editor, other, viewer, nobody } =
      await recordsTenant(app));
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  const create = (headers: Headers, body: object = {}) =>
    createTestItem(app, headers, body);

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(fn: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, fn);
  const audited = (id: string) =>
    inTenant(() =>
      db()
        .select({ action: auditLog.action, details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.targetId, id))
        .orderBy(auditLog.at),
    );

  it('creates one as its owner, with an ETag, an audit entry and the read-only field the service derives', async () => {
    const response = await call('POST', '/v1/test-items', editor.headers, {
      title: 'First',
      body: 'three short words',
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers.etag).toBeTruthy();
    const item = response.json();
    expect(item).toMatchObject({
      title: 'First',
      body: 'three short words',
      status: 'draft',
      words: 3,
      ownerId: `user:${editor.id}`,
      unitId: null,
      deletedAt: null,
      marks: [],
    });
    expect(item).not.toHaveProperty('tenantId');
    expect(item).not.toHaveProperty('search');
    expect((await audited(item.id)).map((entry) => entry.action)).toEqual([
      'testItem.created',
    ]);
  });

  it('refuses a body the schema refuses (400); a read-only field sent is ignored, as unknown keys are', async () => {
    expect(
      (await call('POST', '/v1/test-items', editor.headers, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', '/v1/test-items', editor.headers, {
          title: 'x',
          status: 'gone',
        })
      ).statusCode,
    ).toBe(400);
    const item = await create(editor.headers, { body: 'a b', words: 9 });
    expect(item.words).toBe(2);
  });

  it('reads one: 304 on its ETag, `include=can` outside it, an unknown include a 400', async () => {
    const item = await create(editor.headers);
    const read = await call('GET', `/v1/test-items/${item.id}`, editor.headers);
    expect(read.statusCode).toBe(200);
    const etag = read.headers.etag as string;
    expect(
      (
        await call('GET', `/v1/test-items/${item.id}`, {
          ...editor.headers,
          'if-none-match': etag,
        })
      ).statusCode,
    ).toBe(304);
    const withCan = await call(
      'GET',
      `/v1/test-items/${item.id}?include=can`,
      editor.headers,
    );
    expect(withCan.json().can).toEqual({
      update: true,
      delete: true,
      restore: false,
    });
    expect(withCan.headers.etag).toBe(etag);
    const viewed = await call(
      'GET',
      `/v1/test-items/${item.id}?include=can`,
      viewer.headers,
    );
    expect(viewed.json().can).toEqual({
      update: false,
      delete: false,
      restore: false,
    });
    expect(
      (
        await call(
          'GET',
          `/v1/test-items/${item.id}?include=bogus`,
          editor.headers,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await call('GET', '/v1/test-items/not-a-uuid', editor.headers))
        .statusCode,
    ).toBe(400);
  });

  it('changes one: If-Match must be current (412), the change is audited field by field', async () => {
    const item = await create(editor.headers, { body: 'one two' });
    const url = `/v1/test-items/${item.id}`;
    const etag = (await call('GET', url, editor.headers)).headers
      .etag as string;
    const stale = await call(
      'PATCH',
      url,
      { ...editor.headers, 'if-match': '"stale"' },
      { title: 'Changed' },
    );
    expect(stale.statusCode).toBe(412);
    const changed = await call(
      'PATCH',
      url,
      { ...editor.headers, 'if-match': etag },
      { title: 'Changed', body: 'one two three four' },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ title: 'Changed', words: 4 });
    const updated = (await audited(item.id)).find(
      (entry) => entry.action === 'testItem.updated',
    );
    expect(updated?.details).toMatchObject({
      changes: { title: { from: item.title, to: 'Changed' } },
    });
    const ignored = await call('PATCH', url, editor.headers, { words: 1 });
    expect(ignored.json().words).toBe(4);
  });

  it("hides another's record behind a 404 on every route; one read but not owned is a 403", async () => {
    const item = await create(other.headers);
    const url = `/v1/test-items/${item.id}`;
    for (const [method, path, payload] of [
      ['GET', url],
      ['PATCH', url, { title: 'x' }],
      ['DELETE', url],
      ['PUT', `${url}/marks`, { marks: ['x'] }],
    ] as const) {
      expect(
        (await call(method, path, editor.headers, payload)).statusCode,
        `${method} ${path}`,
      ).toBe(404);
      expect(
        (await call(method, path, nobody.headers, payload)).statusCode,
      ).toBe(404);
    }
    expect((await call('GET', url, viewer.headers)).statusCode).toBe(200);
    expect(
      (await call('PATCH', url, viewer.headers, { title: 'x' })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', url, viewer.headers)).statusCode).toBe(403);
    expect(
      (await call('POST', '/v1/test-items', nobody.headers, { title: 'x' }))
        .statusCode,
    ).toBe(403);
  });

  it('lists what the caller may read, newest first, filtered, searched and narrowed', async () => {
    const a = await create(editor.headers, {
      title: 'Alpha apple',
      status: 'done',
    });
    const b = await create(editor.headers, { title: 'Beta banana' });
    await create(other.headers, { title: 'Other apple' });
    const mine = (
      await call('GET', '/v1/test-items?limit=100', editor.headers)
    ).json();
    expect(
      mine.items.every(
        (i: { ownerId: string }) => i.ownerId === `user:${editor.id}`,
      ),
    ).toBe(true);
    expect(mine.items[0].id).toBe(b.id);
    expect(mine.items[1].id).toBe(a.id);
    const done = (
      await call('GET', '/v1/test-items?status=done', editor.headers)
    ).json();
    expect(done.items.map((i: { id: string }) => i.id)).toContain(a.id);
    expect(
      done.items.every((i: { status: string }) => i.status === 'done'),
    ).toBe(true);
    const searched = (
      await call('GET', '/v1/test-items?q=apple', editor.headers)
    ).json();
    expect(searched.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    const narrowed = (
      await call('GET', `/v1/test-items?fields=title&limit=1`, editor.headers)
    ).json();
    expect(Object.keys(narrowed.items[0]).sort()).toEqual(['id', 'title']);
    expect(
      (await call('GET', '/v1/test-items?nope=1', editor.headers)).statusCode,
    ).toBe(400);
    const all = (
      await call('GET', '/v1/test-items?limit=100&include=can', viewer.headers)
    ).json();
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    expect(all.items[0].can).toEqual({
      update: false,
      delete: false,
      restore: false,
    });
  });

  it('deletes to the recycle bin and restores; a unique value taken meanwhile is a 409', async () => {
    const item = await create(editor.headers, { code: `C-${randomUUID()}` });
    const url = `/v1/test-items/${item.id}`;
    expect(
      (
        await call('POST', '/v1/test-items', editor.headers, {
          title: 'dup',
          code: item.code,
        })
      ).json().code,
    ).toBe('testItem_taken');
    expect((await call('DELETE', url, editor.headers)).statusCode).toBe(204);
    expect((await call('GET', url, editor.headers)).statusCode).toBe(404);
    const bin = (
      await call(
        'GET',
        '/v1/test-items?deleted=true&include=can',
        editor.headers,
      )
    ).json();
    const binned = bin.items.find((i: { id: string }) => i.id === item.id);
    expect(binned).toMatchObject({ deletedBy: `user:${editor.id}` });
    expect(binned.can.restore).toBe(true);
    expect(
      (await call('POST', `${url}/restore`, other.headers)).statusCode,
    ).toBe(404);
    // Another takes its code while it is in the bin.
    const taker = await create(editor.headers, { code: item.code });
    const refused = await call('POST', `${url}/restore`, editor.headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('testItem_taken');
    await call('PATCH', `/v1/test-items/${taker.id}`, editor.headers, {
      code: null,
    });
    const restored = await call('POST', `${url}/restore`, editor.headers);
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ id: item.id, deletedAt: null });
    expect(
      (await call('POST', `${url}/restore`, editor.headers)).statusCode,
    ).toBe(404);
    expect((await audited(item.id)).map((e) => e.action)).toEqual([
      'testItem.created',
      'testItem.deleted',
      'testItem.restored',
    ]);
  });

  it('replays a create with the same Idempotency-Key', async () => {
    const headers = { ...editor.headers, 'idempotency-key': randomUUID() };
    const first = await call('POST', '/v1/test-items', headers, {
      title: 'Once',
    });
    const again = await call('POST', '/v1/test-items', headers, {
      title: 'Once',
    });
    expect(first.statusCode).toBe(201);
    expect(again.json().id).toBe(first.json().id);
  });

  it('puts a creator in their only unit, which its leads then read', async () => {
    const { unitId, worker, lead } = await unitWithLead(app, {
      tenantId,
      admin,
    });
    const item = await create(worker.headers);
    expect(item.unitId).toBe(unitId);
    const elsewhere = await create(editor.headers);
    expect(
      (await call('GET', `/v1/test-items/${item.id}`, lead.headers)).statusCode,
    ).toBe(200);
    expect(
      (await call('GET', `/v1/test-items/${elsewhere.id}`, lead.headers))
        .statusCode,
    ).toBe(404);
    const listed = (
      await call('GET', `/v1/test-items?unitId=${unitId}`, lead.headers)
    ).json();
    expect(listed.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
  });

  it('lets an API client work on its own records only', async () => {
    const client = await apiClient(app, tenantId);
    const created = await create(client.headers, { title: 'By a client' });
    expect(created.ownerId).toBe(`client:${client.client.id}`);
    const someone = await create(editor.headers);
    const listed = (await call('GET', '/v1/test-items', client.headers)).json();
    expect(listed.items.map((i: { id: string }) => i.id)).toEqual([created.id]);
    expect(
      (await call('GET', `/v1/test-items/${someone.id}`, client.headers))
        .statusCode,
    ).toBe(404);
  });

  it("keeps each tenant's records apart", async () => {
    const item = await create(editor.headers);
    const elsewhere = await tenantWithAdmin(app);
    expect(
      (await call('GET', `/v1/test-items/${item.id}`, elsewhere.admin.headers))
        .statusCode,
    ).toBe(404);
    const listed = (
      await call('GET', '/v1/test-items', elsewhere.admin.headers)
    ).json();
    expect(listed.items).toEqual([]);
  });

  describe('the add-on contract (marks)', () => {
    it('adds its route under the record, its key to responses, its filter and include to the list', async () => {
      const item = await create(editor.headers);
      const url = `/v1/test-items/${item.id}`;
      const set = await call('PUT', `${url}/marks`, editor.headers, {
        marks: ['red', 'blue'],
      });
      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().items).toEqual(['blue', 'red']);
      expect(
        (await call('PUT', `${url}/marks`, viewer.headers, { marks: [] }))
          .statusCode,
      ).toBe(403);
      const read = await call('GET', `${url}?include=marked`, editor.headers);
      expect(read.json()).toMatchObject({
        marks: expect.arrayContaining(['blue', 'red']),
        marked: true,
      });
      const filtered = (
        await call(
          'GET',
          '/v1/test-items?mark=red&fields=marks',
          editor.headers,
        )
      ).json();
      expect(filtered.items).toEqual([
        { id: item.id, marks: expect.arrayContaining(['red']) },
      ]);
    });

    it("runs its hooks in the write's transaction: a mark on update, a refused delete rolled back", async () => {
      const item = await create(editor.headers);
      const url = `/v1/test-items/${item.id}`;
      await call('PATCH', url, editor.headers, { title: 'Edited' });
      expect((await call('GET', url, editor.headers)).json().marks).toContain(
        'edited',
      );
      await call('PUT', `${url}/marks`, editor.headers, { marks: ['locked'] });
      const refused = await call('DELETE', url, editor.headers);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('record_locked');
      expect((await call('GET', url, editor.headers)).statusCode).toBe(200);
      expect((await audited(item.id)).map((e) => e.action)).not.toContain(
        'testItem.deleted',
      );
    });

    it('reacts to the domain event after the commit, without changing what the record shows', async () => {
      const item = await create(editor.headers);
      const etag = (
        await call('GET', `/v1/test-items/${item.id}`, editor.headers)
      ).headers.etag;
      const seen = async () =>
        (
          await inTenant(() =>
            db()
              .select({ id: testRecordSeen.recordId })
              .from(testRecordSeen)
              .where(eq(testRecordSeen.recordId, item.id)),
          )
        ).length > 0;
      await vi.waitFor(async () => expect(await seen()).toBe(true), {
        timeout: 20_000,
        interval: 200,
      });
      expect(
        (await call('GET', `/v1/test-items/${item.id}`, editor.headers)).headers
          .etag,
      ).toBe(etag);
    });

    it('takes part before the write: body keys, a column of its own, a refusal', async () => {
      const item = await create(editor.headers, { marks: ['blue', 'green'] });
      expect(item).toMatchObject({
        lastMark: 'green',
        marks: ['blue', 'green'],
      });
      const url = `/v1/test-items/${item.id}`;
      const changed = await call('PATCH', url, editor.headers, {
        marks: ['red'],
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json()).toMatchObject({ lastMark: 'red' });
      expect(changed.json().marks).toEqual(['edited', 'red']);
      await call('PUT', `${url}/marks`, editor.headers, { marks: ['frozen'] });
      const refused = await call('PATCH', url, editor.headers, { title: 'No' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('record_frozen');
      expect((await call('GET', url, editor.headers)).json().title).toBe(
        item.title,
      );
      expect(
        (
          await call('POST', '/v1/test-items', editor.headers, {
            title: 'x',
            marks: [''],
          })
        ).statusCode,
      ).toBe(400);
    });

    it('describes its capability and its keys in the list description', async () => {
      const response = await call('GET', '/v1/lists/TestItem', editor.headers);
      expect(response.statusCode, response.body).toBe(200);
      const list = response.json();
      expect(list).toMatchObject({
        subject: 'TestItem',
        capabilities: { marks: true },
        markLimit: 10,
        search: true,
        recycleBin: true,
        defaultSort: '-createdAt',
        related: [
          expect.objectContaining({
            subject: 'TestItem',
            field: 'parentId',
            onDelete: 'restrict',
            required: false,
          }),
          expect.objectContaining({ field: 'linkedId', onDelete: 'keep' }),
        ],
        views: { board: { field: 'status', readOnly: false } },
      });
      expect(list.fields.map((f: { name: string }) => f.name)).toContain(
        'mark',
      );
      expect(list.select).toContain('marks');
    });
  });

  describe('relations', () => {
    it('refers only to a live record the writer may read (422), and includes it', async () => {
      const parent = await create(editor.headers, { title: 'Parent' });
      const hidden = await create(other.headers);
      const child = await create(editor.headers, { parentId: parent.id });
      for (const parentId of [
        hidden.id,
        '01900000-0000-7000-8000-000000000000',
      ]) {
        const refused = await call('POST', '/v1/test-items', editor.headers, {
          title: 'x',
          parentId,
        });
        expect(refused.statusCode).toBe(422);
        expect(refused.json()).toMatchObject({
          code: 'reference_not_found',
          field: 'parentId',
        });
      }
      expect(
        (
          await call('PATCH', `/v1/test-items/${child.id}`, editor.headers, {
            parentId: hidden.id,
          })
        ).statusCode,
      ).toBe(422);
      const read = await call(
        'GET',
        `/v1/test-items/${child.id}?include=parent,linked`,
        editor.headers,
      );
      expect(read.json()).toMatchObject({
        parentId: parent.id,
        parent: { id: parent.id, title: 'Parent' },
        linked: null,
      });
      const children = (
        await call(
          'GET',
          `/v1/test-items?parentId=${parent.id}`,
          editor.headers,
        )
      ).json();
      expect(children.items.map((i: { id: string }) => i.id)).toEqual([
        child.id,
      ]);
    });

    it('refuses deleting a record live ones refer to (409); restoring one whose parent is in the bin (409)', async () => {
      const parent = await create(editor.headers);
      const child = await create(editor.headers, { parentId: parent.id });
      const refused = await call(
        'DELETE',
        `/v1/test-items/${parent.id}`,
        editor.headers,
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({
        code: 'record_referenced',
        field: 'parentId',
      });
      // An optional reference counts live referrers only.
      expect(
        (await call('DELETE', `/v1/test-items/${child.id}`, editor.headers))
          .statusCode,
      ).toBe(204);
      expect(
        (await call('DELETE', `/v1/test-items/${parent.id}`, editor.headers))
          .statusCode,
      ).toBe(204);
      const restore = await call(
        'POST',
        `/v1/test-items/${child.id}/restore`,
        editor.headers,
      );
      expect(restore.statusCode).toBe(409);
      expect(restore.json().code).toBe('reference_deleted');
      // `keep`: the linked one goes to the bin, the link stays.
      const linked = await create(editor.headers);
      const linker = await create(editor.headers, { linkedId: linked.id });
      expect(
        (await call('DELETE', `/v1/test-items/${linked.id}`, editor.headers))
          .statusCode,
      ).toBe(204);
      expect(
        (
          await call('GET', `/v1/test-items/${linker.id}`, editor.headers)
        ).json().linkedId,
      ).toBe(linked.id);
    });
  });

  describe('legal holds and the recycle bin purge', () => {
    const ageBin = (ids: string[]) =>
      inTenant(() =>
        db()
          .update(testItems)
          .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
          .where(inArray(testItems.id, ids)),
      );
    const stored = async (ids: string[]) =>
      (
        await inTenant(() =>
          db()
            .select({ id: testItems.id })
            .from(testItems)
            .where(inArray(testItems.id, ids)),
        )
      ).map((row) => row.id);

    it('refuses deleting a held record (409); the purge deletes old bin records for good, never held ones', async () => {
      const held = await create(editor.headers);
      const gone = await create(editor.headers, { marks: ['red'] });
      const linker = await create(editor.headers, { linkedId: gone.id });
      const hold = await call('POST', '/v1/legal-holds', admin.headers, {
        subject: 'TestItem',
        recordId: held.id,
        reason: 'Litigation',
      });
      expect(hold.statusCode, hold.body).toBe(201);
      const refused = await call(
        'DELETE',
        `/v1/test-items/${held.id}`,
        editor.headers,
      );
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('legal_hold');
      // Held after its delete: it stays in the bin.
      const binnedThenHeld = await create(editor.headers);
      await call(
        'DELETE',
        `/v1/test-items/${binnedThenHeld.id}`,
        editor.headers,
      );
      await call('POST', '/v1/legal-holds', admin.headers, {
        subject: 'TestItem',
        recordId: binnedThenHeld.id,
        reason: 'Litigation',
      });
      await call('DELETE', `/v1/test-items/${gone.id}`, editor.headers);
      await ageBin([gone.id, binnedThenHeld.id]);
      expect(await app.get(RecycleBinPurgeJob).run()).toBeGreaterThanOrEqual(1);
      expect(await stored([gone.id, binnedThenHeld.id])).toEqual([
        binnedThenHeld.id,
      ]);
      // The add-on forgot it; the optional reference to it emptied.
      const marks = await inTenant(() =>
        db()
          .select()
          .from(testRecordMarks)
          .where(eq(testRecordMarks.recordId, gone.id)),
      );
      expect(marks).toEqual([]);
      expect(
        (
          await call('GET', `/v1/test-items/${linker.id}`, editor.headers)
        ).json().linkedId,
      ).toBeNull();
      const purged = await inTenant(() =>
        db()
          .select({ details: auditLog.details })
          .from(auditLog)
          .where(and(eq(auditLog.action, 'records.purged'))),
      );
      expect(JSON.stringify(purged)).toContain(gone.id);
    });
  });

  describe('lists and search', () => {
    it('answers a list description to who may read the subject; an unknown subject is a 404', async () => {
      expect(
        (await call('GET', '/v1/lists/TestItem', nobody.headers)).statusCode,
      ).toBe(403);
      expect(
        (await call('GET', '/v1/lists/Nothing', editor.headers)).statusCode,
      ).toBe(404);
      expect(
        (await call('GET', '/v1/lists/User', admin.headers)).statusCode,
      ).toBe(200);
      expect(
        (await call('GET', '/v1/lists/User', editor.headers)).statusCode,
      ).toBe(403);
    });

    it('searches every record the caller may read, with a snippet', async () => {
      const word = `zebra${randomUUID().slice(0, 6)}`;
      const item = await create(editor.headers, { body: `a ${word} crossing` });
      await create(other.headers, { body: `another ${word}` });
      const response = await call(
        'GET',
        `/v1/search?q=${word}`,
        editor.headers,
      );
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items).toEqual([
        expect.objectContaining({
          subject: 'TestItem',
          id: item.id,
          link: `/test-items/${item.id}`,
          snippet: expect.stringContaining(`<b>${word}</b>`),
          subjectLabel: { singular: 'Test item', plural: 'Test items' },
        }),
      ]);
      expect(
        (await call('GET', `/v1/search?q=${word}`, viewer.headers)).json()
          .items,
      ).toHaveLength(2);
    });
  });
});
