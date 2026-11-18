import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq, inArray } from 'drizzle-orm';
import { tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItems } from '../../../test/fixtures/test-items/test-items.tables.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RecycleBinPurgeJob } from '../records/recycle-bin.job.js';
import { MAX_RECENTS } from './recents.schemas.js';
import { RecentsModule } from './recents.module.js';
import { RecentsRetentionJob } from './recents.retention.job.js';
import { recentRecords } from './recents.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-recents-${process.pid}:`;
});

type Recent = { id: string; subject: string; recordId: string; label: string };

describe('recents: recently opened records (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      testItemsModule({ imports: [RecentsModule.forRecord(TEST_ITEM)] }),
    );
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    team = await recordsTenant(app);
  });

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const list = async (headers: Headers) =>
    (await call('GET', '/v1/recents', headers)).json<{ items: Recent[] }>()
      .items;
  const open = (headers: Headers, recordId: string, label = 'Plan') =>
    call('POST', '/v1/recents', headers, {
      subject: 'TestItem',
      recordId,
      label,
    });
  const item = async (headers: Headers, title: string) =>
    (await createTestItem(app, headers, { title })).id;
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(fn: () => Promise<T>) =>
    app.get(Tenancy).run(team.tenantId, fn);

  it('lists what the user opened, newest first, once each, and theirs alone', async () => {
    const first = await item(team.editor.headers, 'First');
    const second = await item(team.editor.headers, 'Second');

    for (const [id, label] of [
      [first, 'First'],
      [second, 'Second'],
      // Opening one again moves it up, it is not listed twice.
      [first, 'First, renamed'],
    ] as const) {
      expect((await open(team.editor.headers, id, label)).statusCode).toBe(200);
    }
    expect(
      (await list(team.editor.headers)).map((r) => [r.recordId, r.label]),
    ).toEqual([
      [first, 'First, renamed'],
      [second, 'Second'],
    ]);

    // Someone who can't read the record can't note it (as if missing), and has their own list.
    expect((await open(team.other.headers, first)).statusCode).toBe(404);
    expect(await list(team.other.headers)).toEqual([]);
    // Malformed: no subject shape, no id; a subject that takes no recents.
    for (const body of [
      { subject: 'x', recordId: first, label: 'x' },
      { subject: 'TestItem', recordId: 'nope', label: 'x' },
    ]) {
      expect(
        (await call('POST', '/v1/recents', team.editor.headers, body))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await call('POST', '/v1/recents', team.editor.headers, {
          subject: 'Invoice',
          recordId: first,
          label: 'x',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('is bounded, removes one, and is cleared by its owner', async () => {
    const ids: string[] = [];
    for (let i = 0; i <= MAX_RECENTS; i++) {
      const id = await item(team.editor.headers, `Item ${i}`);
      ids.push(id);
      expect(
        (await open(team.editor.headers, id, `Item ${i}`)).statusCode,
      ).toBe(200);
    }
    const recents = await list(team.editor.headers);
    // The oldest dropped out.
    expect(recents).toHaveLength(MAX_RECENTS);
    expect(recents.map((r) => r.recordId)).not.toContain(ids[0]);
    expect(recents[0]!.recordId).toBe(ids.at(-1));

    const one = `/v1/recents/${recents[0]!.id}`;
    expect((await call('DELETE', one, team.editor.headers)).statusCode).toBe(
      204,
    );
    expect((await call('DELETE', one, team.editor.headers)).statusCode).toBe(
      404,
    );
    expect(await list(team.editor.headers)).toHaveLength(MAX_RECENTS - 1);

    expect(
      (await call('DELETE', '/v1/recents', team.editor.headers)).statusCode,
    ).toBe(204);
    expect(await list(team.editor.headers)).toEqual([]);
  });

  it('leaves out a record once it is deleted, forgets it when purged, and keeps tenants apart', async () => {
    const gone = await item(team.editor.headers, 'Gone soon');
    await open(team.editor.headers, gone, 'Gone soon');
    expect(await list(team.editor.headers)).toHaveLength(1);
    await call('DELETE', `/v1/test-items/${gone}`, team.editor.headers);
    expect(await list(team.editor.headers)).toEqual([]);

    await inTenant(() =>
      db()
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(inArray(testItems.id, [gone])),
    );
    await app.get(RecycleBinPurgeJob).run();
    expect(
      await inTenant(() =>
        db()
          .select()
          .from(recentRecords)
          .where(eq(recentRecords.recordId, gone)),
      ),
    ).toEqual([]);

    // Another tenant's user neither notes nor sees this tenant's records.
    const kept = await item(team.editor.headers, 'Kept');
    await open(team.editor.headers, kept, 'Kept');
    const stranger = await tenantWithAdmin(app);
    expect((await open(stranger.admin.headers, kept)).statusCode).toBe(404);
    expect(await list(stranger.admin.headers)).toEqual([]);
  });

  it('deletes entries past the retention on the nightly sweep and never lists them', async () => {
    const old = await item(team.editor.headers, 'Old');
    const fresh = await item(team.editor.headers, 'Fresh');
    await open(team.editor.headers, old, 'Old');
    await open(team.editor.headers, fresh, 'Fresh');
    await inTenant(() =>
      db()
        .update(recentRecords)
        .set({ viewedAt: new Date(Date.now() - 40 * 86_400_000) })
        .where(eq(recentRecords.recordId, old)),
    );
    // Expired is not listed even before the sweep…
    expect((await list(team.editor.headers)).map((r) => r.recordId)).toEqual([
      fresh,
    ]);
    // …and the sweep deletes it (and any other tenant's expired entries).
    expect(await app.get(RecentsRetentionJob).run()).toBeGreaterThanOrEqual(1);
    expect(
      await inTenant(() =>
        db()
          .select()
          .from(recentRecords)
          .where(eq(recentRecords.recordId, old)),
      ),
    ).toEqual([]);
  });
});
