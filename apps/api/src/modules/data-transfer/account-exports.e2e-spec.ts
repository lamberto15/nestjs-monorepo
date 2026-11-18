import { TransactionHost } from '@nestjs-cls/transactional';
import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { StorageDisk } from '@nestjs/storage';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { accessTokenFor } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { recordsTenant, testItemModules } from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { SharedLocksModule } from '../../core/locks/locks.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { PersonalDataModule } from '../../iam/personal-data/personal-data.module.js';
import { PersonalDataService } from '../../iam/personal-data/personal-data.service.js';
import { AvatarsModule } from '../attachments/avatars/avatars.module.js';
import { userAvatars } from '../attachments/avatars/avatars.tables.js';
import { FavoritesModule } from '../favorites/favorites.module.js';
import { favorites } from '../favorites/favorites.tables.js';
import { StorageModule } from '../storage/storage.module.js';
import { ACCOUNT_EXPORTS, expiryOf } from './account-exports.service.js';
import { AccountExportsModule } from './account-exports.module.js';
import { keptUntil, TRANSFER_KEPT_MS } from './transfer-retention.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-account-exports-${process.pid}-${Date.now()}`,
  });
});

/** The path and query of a signed URL: the tests reach the app without a port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

describe('account export, personal data sections and who-am-I parts (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      StorageModule,
      PersonalDataModule,
      AvatarsModule,
      AccountExportsModule,
      SharedLocksModule,
      testItemsModule({ imports: [FavoritesModule.forRecord(TEST_ITEM)] }),
    );
    db = app.get<Database>(getDrizzleToken());
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    await app
      ?.get<Queue>(getQueueToken(ACCOUNT_EXPORTS))
      .obliterate({ force: true });
    await app?.close();
  });

  const tenancy = () => app.get(Tenancy);

  it('adds the picture to who-am-I', async () => {
    const me = () =>
      app
        .inject({
          method: 'GET',
          url: '/v1/auth/me',
          headers: team.editor.headers,
        })
        .then((response) => response.json());
    expect((await me()).avatarUrl).toBeNull();
    await tenancy().run(null, () =>
      db.insert(userAvatars).values({
        userId: team.editor.id,
        key: `accounts/${team.editor.id}/avatar/one.png`,
      }),
    );
    expect((await me()).avatarUrl).toContain(
      `/v1/people/${team.editor.id}/avatar`,
    );
  });

  it('exports what the sections hold about the person, to them alone, then erases it', async () => {
    const pinned = await app.inject({
      method: 'POST',
      url: '/v1/favorites',
      headers: team.editor.headers,
      payload: { kind: 'page', target: '/test-items', label: 'Test items' },
    });
    expect(pinned.statusCode).toBe(201);

    const started = await app.inject({
      method: 'POST',
      url: '/v1/account/export',
      headers: team.editor.headers,
      payload: { format: 'csv' },
    });
    expect(started.statusCode).toBe(202);
    const { id } = started.json<{ id: string }>();
    let url = '';
    await vi.waitFor(
      async () => {
        const status = (
          await app.inject({
            method: 'GET',
            url: `/v1/account/exports/${id}`,
            headers: team.editor.headers,
          })
        ).json<{
          status: string;
          kind: string;
          name: string;
          progress: { processed?: number };
          result?: { url: string };
        }>();
        expect(status.status).toBe('completed');
        // Shaped like a transfer: the pages show both alike.
        expect([status.kind, status.name]).toEqual(['export', 'account']);
        expect(status.progress.processed).toBeGreaterThan(0);
        url = status.result!.url;
      },
      { timeout: 60_000 },
    );
    const file = (await app.inject({ method: 'GET', url: local(url) })).body;
    expect(file).toContain('favorites');
    expect(file).toContain('Test items');
    expect(file).toContain('avatar');

    // The request is audited in no tenant, as the person's own.
    const entries = await tenancy().run(null, () =>
      db.select().from(auditLog).where(eq(auditLog.targetId, id)),
    );
    expect(entries.map((entry) => entry.action)).toEqual([
      'data.export-started',
    ]);

    const listed = (
      await app.inject({
        method: 'GET',
        url: '/v1/account/exports',
        headers: team.editor.headers,
      })
    ).json<{ items: { id: string }[] }>();
    expect(listed.items.map((item) => item.id)).toContain(id);
    for (const headers of [team.other.headers]) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/account/exports/${id}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/v1/account/exports',
            headers,
          })
        ).json<{ items: unknown[] }>().items,
      ).toEqual([]);
    }

    const personal = app.get(PersonalDataService);
    const tx = app.get(TransactionHost);
    await tenancy().run(team.tenantId, () =>
      tx.withTransaction(() => personal.erase(team.editor.id, team.tenantId)),
    );
    await tenancy().run(null, () =>
      tx.withTransaction(() => personal.erase(team.editor.id, null)),
    );
    expect(
      await tenancy().run(team.tenantId, () =>
        db
          .select()
          .from(favorites)
          .where(eq(favorites.owner, `user:${team.editor.id}`)),
      ),
    ).toEqual([]);
    expect(
      await tenancy().run(null, () =>
        db
          .select()
          .from(userAvatars)
          .where(eq(userAvatars.userId, team.editor.id)),
      ),
    ).toEqual([]);
  });

  it('gives no link once the export has expired', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/v1/account/export',
      headers: team.viewer.headers,
      payload: { format: 'csv' },
    });
    const { id } = started.json<{ id: string }>();
    type Shown = {
      status: string;
      expiresAt: string;
      result?: { rows: number; url?: string };
    };
    const read = async (headers: Record<string, string>) => ({
      detail: (
        await app.inject({
          method: 'GET',
          url: `/v1/account/exports/${id}`,
          headers,
        })
      ).json<Shown>(),
      listed: (
        await app.inject({
          method: 'GET',
          url: '/v1/account/exports',
          headers,
        })
      )
        .json<{ items: (Shown & { id: string })[] }>()
        .items.find((item) => item.id === id),
    });
    let expiresAt = 0;
    await vi.waitFor(
      async () => {
        const { detail } = await read(team.viewer.headers);
        expect(detail.status).toBe('completed');
        expect(detail.result!.url).toEqual(expect.any(String));
        expiresAt = Date.parse(detail.expiresAt);
      },
      { timeout: 60_000 },
    );

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(expiresAt + 1);
      const { headers } = await accessTokenFor(app, team.viewer.id, null);
      const { detail, listed } = await read(headers);
      for (const shown of [detail, listed]) {
        expect(shown).toMatchObject({
          status: 'completed',
          result: { rows: expect.any(Number) },
        });
        expect(shown!.result).not.toHaveProperty('url');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes an export's file on its deadline, and keeps the fresh exports and the pictures", async () => {
    const disk = app.get(StorageDisk);
    const queue = app.get<Queue>(getQueueToken(ACCOUNT_EXPORTS));
    const owner = team.other;
    const picture = `accounts/${owner.id}/avatar/kept.png`;
    await disk.put(picture, 'png');
    const exported = async () => {
      const { id } = (
        await app.inject({
          method: 'POST',
          url: '/v1/account/export',
          headers: owner.headers,
          payload: { format: 'csv' },
        })
      ).json<{ id: string }>();
      let done: { key: string; finishedOn: number } | undefined;
      await vi.waitFor(
        async () => {
          const job = await queue.getJob(id);
          expect(await job!.getState()).toBe('completed');
          done = { key: job!.returnvalue.key, finishedOn: job!.finishedOn! };
        },
        { timeout: 60_000 },
      );
      return { id, ...done! };
    };
    const old = await exported();
    const fresh = await exported();
    for (const { key } of [old, fresh]) {
      expect(await disk.exists(key)).toBe(true);
    }

    // Each export has its own deletion, waiting for the export's deadline.
    const expiry = (await queue.getJob(expiryOf(old.id)))!;
    expect(await expiry.getState()).toBe('delayed');
    expect(expiry.data).toEqual({ tenantId: null, key: old.key });
    expect(expiry.delay).toBe(TRANSFER_KEPT_MS);
    const due = expiry.timestamp + expiry.delay;
    expect(due).toBeLessThanOrEqual(keptUntil(old.finishedOn));
    expect(keptUntil(old.finishedOn) - due).toBeLessThan(5_000);

    // Its deadline reached (promoted, rather than waited for).
    await expiry.promote();
    await vi.waitFor(
      async () => expect(await disk.exists(old.key)).toBe(false),
      { timeout: 30_000 },
    );
    expect(await queue.getJob(expiryOf(old.id))).toBeUndefined();
    expect(await disk.exists(fresh.key)).toBe(true);
    expect(await disk.exists(picture)).toBe(true);
    expect(await (await queue.getJob(expiryOf(fresh.id)))!.getState()).toBe(
      'delayed',
    );
  });
});
