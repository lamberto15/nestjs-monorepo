import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq, inArray } from 'drizzle-orm';
import { member } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import {
  createTestItem,
  type Headers,
  type Member,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { testItems } from '../../../test/fixtures/test-items/test-items.tables.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RecycleBinPurgeJob } from '../records/recycle-bin.job.js';
import { PeopleModule } from '../people/people.module.js';
import { RevisionRetentionJob } from './revision-retention.job.js';
import { RevisionsModule } from './revisions.module.js';
import { revisions } from './revisions.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-revisions-${process.pid}:`;
  process.env.REVISIONS_RETENTION_DAYS = '30';
});

interface Rev {
  id: string;
  number: number;
  snapshot: Record<string, unknown>;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  restoredFrom: number | null;
  changedBy: string;
  changedByName: string | null;
}

describe('revisions (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Member;
  let editor: Member;
  let other: Member;
  let viewer: Member;
  let nobody: Member;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      PeopleModule,
      testItemsModule({ imports: [RevisionsModule.forRecord(TEST_ITEM)] }),
    );
    ({ tenantId, admin, editor, other, viewer, nobody } =
      await recordsTenant(app));
  });
  afterAll(() => app?.close());

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(fn: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, fn);
  const revs = (id: string, headers: Headers = editor.headers, query = '') =>
    call('GET', `/v1/test-items/${id}/revisions${query}`, headers);
  const patch = (id: string, headers: Headers, body: object) =>
    call('PATCH', `/v1/test-items/${id}`, headers, body);

  it('keeps revision 1 on create and one per change, with what changed and who', async () => {
    const item = await createTestItem(app, editor.headers, { title: 'Draft' });
    expect(
      (await patch(item.id, editor.headers, { title: 'Plan' })).statusCode,
    ).toBe(200);
    const list = await revs(item.id);
    expect(list.statusCode, list.body).toBe(200);
    const { items } = list.json<{ items: Rev[] }>();
    expect(items.map((r) => r.number)).toEqual([2, 1]);
    expect(items[0]).toMatchObject({
      changes: { title: { from: 'Draft', to: 'Plan' } },
      restoredFrom: null,
      changedBy: `user:${editor.id}`,
    });
    // The name comes from the people directory (an ActorNameSource).
    expect(items[0]!.changedByName).toEqual(expect.any(String));
    expect(items[0]!.snapshot).toMatchObject({
      title: 'Plan',
      status: 'draft',
    });
    // Only what a person may change: not the read-only field, nor the engine's columns.
    expect(items[0]!.snapshot).not.toHaveProperty('words');
    expect(items[0]!.snapshot).not.toHaveProperty('ownerId');
    expect(items[1]).toMatchObject({ changes: null });
    // A write that changes nothing adds no revision.
    await patch(item.id, editor.headers, { title: 'Plan' });
    expect((await revs(item.id)).json<{ items: Rev[] }>().items).toHaveLength(
      2,
    );
  });

  it('pages newest first, filters, reads one and diffs two', async () => {
    const item = await createTestItem(app, editor.headers, { title: 'A' });
    for (const title of ['B', 'C']) {
      await patch(item.id, editor.headers, { title });
    }
    const first = (await revs(item.id, editor.headers, '?limit=2')).json<{
      items: Rev[];
      nextCursor: string | null;
    }>();
    expect(first.items.map((r) => r.number)).toEqual([3, 2]);
    expect(first.nextCursor).toBeTruthy();
    const second = (
      await revs(item.id, editor.headers, `?limit=2&cursor=${first.nextCursor}`)
    ).json<{ items: Rev[]; nextCursor: string | null }>();
    expect(second.items.map((r) => r.number)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await revs(item.id, editor.headers, '?number.gte=3')).json<{
        items: Rev[];
      }>().items,
    ).toHaveLength(1);
    expect(
      (await revs(item.id, editor.headers, '?cursor=nope')).statusCode,
    ).toBe(400);

    const one = await call(
      'GET',
      `/v1/test-items/${item.id}/revisions/2`,
      editor.headers,
    );
    expect(one.json()).toMatchObject({ number: 2, snapshot: { title: 'B' } });
    for (const [number, status] of [
      ['99', 404],
      ['0', 404],
      ['abc', 400],
    ] as const) {
      expect(
        (
          await call(
            'GET',
            `/v1/test-items/${item.id}/revisions/${number}`,
            editor.headers,
          )
        ).statusCode,
      ).toBe(status);
    }
    const diff = await call(
      'GET',
      `/v1/test-items/${item.id}/revisions/1/diff/3`,
      editor.headers,
    );
    expect(diff.json()).toEqual({
      from: 1,
      to: 3,
      changes: { title: { from: 'A', to: 'C' } },
    });
    const back = await call(
      'GET',
      `/v1/test-items/${item.id}/revisions/3/diff/1`,
      editor.headers,
    );
    expect(back.json().changes).toEqual({ title: { from: 'C', to: 'A' } });
  });

  it('shows revisions to whoever may read the record, and hides the record from the others', async () => {
    const item = await createTestItem(app, editor.headers, { title: 'Mine' });
    expect((await revs(item.id, viewer.headers)).statusCode).toBe(200);
    expect((await revs(item.id, admin.headers)).statusCode).toBe(200);
    for (const headers of [other.headers, nobody.headers]) {
      expect((await revs(item.id, headers)).statusCode).toBe(404);
    }
  });

  it('leaves out the fields the reader may not see', async () => {
    const item = await createTestItem(app, editor.headers, {
      title: 'Secret',
      body: 'hidden words',
    });
    await patch(item.id, editor.headers, { body: 'changed words' });
    const shown = (headers: Headers) =>
      call('GET', `/v1/test-items/${item.id}`, headers).then((r) =>
        r.json<Record<string, unknown>>(),
      );
    for (const member of [editor, viewer]) {
      const { items } = (await revs(item.id, member.headers)).json<{
        items: Rev[];
      }>();
      const record = await shown(member.headers);
      expect(Object.hasOwn(items[0]!.snapshot, 'body')).toBe(
        Object.hasOwn(record, 'body'),
      );
      expect(Object.hasOwn(items[0]!.changes ?? {}, 'body')).toBe(
        Object.hasOwn(record, 'body'),
      );
    }
  });

  it('lists no revision that changed only fields the reader may not see', async () => {
    const role = await call('POST', '/v1/access/roles', admin.headers, {
      name: `no-fields-${randomUUID().slice(0, 8)}`,
      // Every test item, none of its granted fields (`body`).
      permissions: [
        { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
      ],
    });
    expect(role.statusCode, role.body).toBe(201);
    const reader = await member(app, tenantId, [role.json().id]);
    const item = await createTestItem(app, admin.headers, {
      title: 'Quiet',
      body: 'before',
    });
    expect(
      (await patch(item.id, admin.headers, { body: 'after' })).statusCode,
    ).toBe(200);
    expect(
      (await revs(item.id, admin.headers))
        .json()
        .items.map((r: Rev) => r.number),
    ).toEqual([2, 1]);

    const list = (await revs(item.id, reader.headers, '?count=true')).json<{
      items: Rev[];
      total: number;
    }>();
    expect(list.items.map((r) => r.number)).toEqual([1]);
    expect(list.total).toBe(1);
    const one = (number: number) =>
      call(
        'GET',
        `/v1/test-items/${item.id}/revisions/${number}`,
        reader.headers,
      );
    expect((await one(1)).statusCode).toBe(200);
    expect((await one(2)).statusCode).toBe(404);
    expect(
      (
        await call(
          'GET',
          `/v1/test-items/${item.id}/revisions/1/diff/2`,
          reader.headers,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('restores no revision the reader may not see', async () => {
    const role = await call('POST', '/v1/access/roles', admin.headers, {
      name: `restorer-${randomUUID().slice(0, 8)}`,
      permissions: [
        { subject: 'TestItem', action: 'read', conditions: [], fields: [] },
        { subject: 'TestItem', action: 'update', conditions: [] },
      ],
    });
    expect(role.statusCode, role.body).toBe(201);
    const restorer = await member(app, tenantId, [role.json().id]);
    const item = await createTestItem(app, admin.headers, {
      title: 'Kept',
      body: 'before',
    });
    await patch(item.id, admin.headers, { body: 'after' });
    // Revision 2 changed only `body`: as hidden from them as its GET.
    const restore = (number: number) =>
      call(
        'POST',
        `/v1/test-items/${item.id}/revisions/${number}/restore`,
        restorer.headers,
      );
    expect((await restore(2)).statusCode).toBe(404);
    expect(
      (await revs(item.id, admin.headers))
        .json()
        .items.map((r: Rev) => r.number),
    ).toEqual([2, 1]);
  });

  it('restores a revision through the record: audited, a new revision, ETag and permissions as a PATCH', async () => {
    const item = await createTestItem(app, editor.headers, {
      title: 'One',
      status: 'draft',
    });
    await patch(item.id, editor.headers, { title: 'Two', status: 'done' });
    const url = `/v1/test-items/${item.id}/revisions/1/restore`;

    expect((await call('POST', url, viewer.headers)).statusCode).toBe(403);
    expect((await call('POST', url, other.headers)).statusCode).toBe(404);
    expect(
      (
        await call('POST', url, {
          ...editor.headers,
          'if-match': '"stale"',
        })
      ).statusCode,
    ).toBe(412);

    const current = await call(
      'GET',
      `/v1/test-items/${item.id}`,
      editor.headers,
    );
    const restored = await call('POST', url, {
      ...editor.headers,
      'if-match': current.headers.etag as string,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.headers.etag).toBeTruthy();
    expect(restored.json()).toMatchObject({ title: 'One', status: 'draft' });
    const { items } = (await revs(item.id)).json<{ items: Rev[] }>();
    expect(items[0]).toMatchObject({
      number: 3,
      restoredFrom: 1,
      changes: {
        title: { from: 'Two', to: 'One' },
        status: { from: 'done', to: 'draft' },
      },
    });
    // Restoring what the record already has writes nothing.
    expect((await call('POST', url, editor.headers)).statusCode).toBe(200);
    expect((await revs(item.id)).json<{ items: Rev[] }>().items).toHaveLength(
      3,
    );
  });

  it('forgets the revisions of a record purged from the recycle bin', async () => {
    const item = await createTestItem(app, editor.headers, { title: 'Gone' });
    await call('DELETE', `/v1/test-items/${item.id}`, editor.headers);
    const kept = () =>
      inTenant(() =>
        db().select().from(revisions).where(eq(revisions.recordId, item.id)),
      );
    expect(await kept()).toHaveLength(1);
    await inTenant(() =>
      db()
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(inArray(testItems.id, [item.id])),
    );
    await app.get(RecycleBinPurgeJob).run();
    expect(await kept()).toEqual([]);
  });

  it("deletes old revisions every night, never a record's latest", async () => {
    const item = await createTestItem(app, editor.headers, { title: 'Aged' });
    await patch(item.id, editor.headers, { title: 'Aged 2' });
    await patch(item.id, editor.headers, { title: 'Aged 3' });
    const old = new Date(Date.now() - 60 * 86_400_000);
    await inTenant(() =>
      db()
        .update(revisions)
        .set({ changedAt: old })
        .where(eq(revisions.recordId, item.id)),
    );
    expect(await app.get(RevisionRetentionJob).run()).toBeGreaterThanOrEqual(2);
    const left = await inTenant(() =>
      db().select().from(revisions).where(eq(revisions.recordId, item.id)),
    );
    expect(left.map((r) => r.number)).toEqual([3]);
  });
});
