import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq, inArray } from 'drizzle-orm';
import { tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import {
  createTestItem,
  type Headers,
  mergeTestItems,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItems } from '../../../test/fixtures/test-items/test-items.tables.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RecycleBinPurgeJob } from '../records/recycle-bin.job.js';
import { FavoritesModule } from './favorites.module.js';
import { favorites } from './favorites.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-favorites-${process.pid}:`;
});

type Favorite = { id: string; kind: string; target: string; label: string };

describe('favorites: pinned records and pages (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      testItemsModule({ imports: [FavoritesModule.forRecord(TEST_ITEM)] }),
    );
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    team = await recordsTenant(app);
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const list = async (headers: Headers) =>
    (await call('GET', '/v1/favorites', headers)).json<{ items: Favorite[] }>()
      .items;
  const pinItem = (headers: Headers, target: string, label = 'Plan') =>
    call('POST', '/v1/favorites', headers, {
      kind: 'record',
      subject: 'TestItem',
      target,
      label,
    });

  it('pins what the user sees, in their order, once each, and theirs alone', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Plan',
    });

    const record = (
      await pinItem(team.editor.headers, item.id)
    ).json<Favorite>();
    const page = (
      await call('POST', '/v1/favorites', team.editor.headers, {
        kind: 'page',
        target: '/test-items',
        label: 'Test items',
      })
    ).json<Favorite>();
    // The same thing twice is refused; a record the user can't read can't be pinned (as if missing).
    expect((await pinItem(team.editor.headers, item.id)).statusCode).toBe(409);
    expect((await pinItem(team.other.headers, item.id)).statusCode).toBe(404);
    // Malformed: a record without its subject, a page that is no path, a subject that takes no favorites.
    for (const body of [
      { kind: 'record', target: item.id, label: 'x' },
      { kind: 'page', target: 'notes', label: 'x' },
    ]) {
      expect(
        (await call('POST', '/v1/favorites', team.editor.headers, body))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await call('POST', '/v1/favorites', team.editor.headers, {
          kind: 'record',
          subject: 'Invoice',
          target: item.id,
          label: 'x',
        })
      ).statusCode,
    ).toBe(404);

    expect((await list(team.editor.headers)).map((f) => f.id)).toEqual([
      record.id,
      page.id,
    ]);
    expect(await list(team.other.headers)).toEqual([]);

    // The record says whether it is the reader's favorite (outside the ETag).
    const included = await call(
      'GET',
      `/v1/test-items/${item.id}?include=favorite`,
      team.editor.headers,
    );
    expect(included.json().favorite).toBe(record.id);
    const plain = await call(
      'GET',
      `/v1/test-items/${item.id}`,
      team.editor.headers,
    );
    expect(plain.headers.etag).toBe(included.headers.etag);

    // Reordered: every favorite once, else refused.
    expect(
      (
        await call('PUT', '/v1/favorites/order', team.editor.headers, {
          ids: [page.id],
        })
      ).statusCode,
    ).toBe(400);
    const reordered = await call(
      'PUT',
      '/v1/favorites/order',
      team.editor.headers,
      {
        ids: [page.id, record.id],
      },
    );
    expect(
      reordered.json<{ items: Favorite[] }>().items.map((f) => f.id),
    ).toEqual([page.id, record.id]);

    // Someone else's favorite is not theirs to remove.
    expect(
      (await call('DELETE', `/v1/favorites/${page.id}`, team.other.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `/v1/favorites/${page.id}`, team.editor.headers))
        .statusCode,
    ).toBe(204);
    expect((await list(team.editor.headers)).map((f) => f.id)).toEqual([
      record.id,
    ]);
  });

  it('leaves out a record once it is deleted, before showing its label, and forgets it when it is purged', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Gone soon',
    });
    await pinItem(team.editor.headers, item.id, 'Gone soon');
    expect(await list(team.editor.headers)).toHaveLength(1);

    await call('DELETE', `/v1/test-items/${item.id}`, team.editor.headers);
    expect(await list(team.editor.headers)).toEqual([]);

    const inTenant = <T>(fn: () => Promise<T>) =>
      app.get(Tenancy).run(team.tenantId, fn);
    const db = app.get<Database>(getDrizzleToken());
    await inTenant(() =>
      db
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(inArray(testItems.id, [item.id])),
    );
    await app.get(RecycleBinPurgeJob).run();
    expect(
      await inTenant(() =>
        db.select().from(favorites).where(eq(favorites.target, item.id)),
      ),
    ).toEqual([]);
  });

  it('keeps tenants apart', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Mine',
    });
    await pinItem(team.editor.headers, item.id);
    const stranger = await tenantWithAdmin(app);
    expect(await list(stranger.admin.headers)).toEqual([]);
    expect((await pinItem(stranger.admin.headers, item.id)).statusCode).toBe(
      404,
    );
  });

  it('pins a saved view while its owner sees it, and drops it when the view is gone', async () => {
    const saved = await call('POST', '/v1/views', team.editor.headers, {
      subject: 'TestItem',
      name: `Drafts ${Date.now()}`,
      query: { sort: '-createdAt' },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const view = saved.json<{ id: string }>();
    const pin = (headers: Headers) =>
      call('POST', '/v1/favorites', headers, {
        kind: 'view',
        subject: '/test-items',
        target: view.id,
        label: 'Drafts',
      });
    // A private view is nobody else's to pin.
    expect((await pin(team.other.headers)).statusCode).toBe(404);
    expect((await pin(team.editor.headers)).statusCode).toBe(201);
    expect((await list(team.editor.headers)).map((f) => f.kind)).toEqual([
      'view',
    ]);
    await call('DELETE', `/v1/views/${view.id}`, team.editor.headers);
    expect(await list(team.editor.headers)).toEqual([]);
  });

  // modules/merge calls the hook; its test of every hook is its own.
  it('points a favorite of a merged duplicate at the survivor (RecordHooks.merged)', async () => {
    const survivor = await createTestItem(app, team.admin.headers);
    const duplicate = await createTestItem(app, team.admin.headers);
    expect((await pinItem(team.admin.headers, duplicate.id)).statusCode).toBe(
      201,
    );
    await mergeTestItems(app, team.tenantId, duplicate.id, survivor.id);
    expect((await list(team.admin.headers)).map((f) => f.target)).toEqual([
      survivor.id,
    ]);
  });
});
