import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { attachments } from '../attachments/attachments.tables.js';
import { CommentsModule } from '../comments/comments.module.js';
import { FavoritesModule } from '../favorites/favorites.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { recordSubscriptions } from '../notifications/notifications.tables.js';
import { TagsModule } from '../tags/tags.module.js';
import { TAGS_RESPONSE } from '../tags/tags.schemas.js';
import { StorageModule } from '../storage/storage.module.js';
import { MergeModule } from './merge.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    REDIS_PREFIX: `test-merge-addons-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

/**
 * A merge moves what the add-ons keep about the duplicate to the survivor,
 * in its transaction (RecordHooks.merged): tags, comments, attachments,
 * favorites and watchers.
 */
describe('merging with add-ons (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      StorageModule,
      NotificationsModule,
      testItemsModule({
        imports: [
          MergeModule.forRecord(TEST_ITEM),
          TagsModule.forRecord(TEST_ITEM),
          CommentsModule.forRecord(TEST_ITEM),
          AttachmentsModule.forRecord(TEST_ITEM),
          FavoritesModule.forRecord(TEST_ITEM),
          NotificationsModule.forRecord(TEST_ITEM),
        ],
        response: TAGS_RESPONSE,
      }),
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  it("moves the duplicate's tags, comments, attachments, favorites and watchers", async () => {
    const { tenantId, admin, editor } = await recordsTenant(app);
    const db = app.get<Database>(getDrizzleToken());
    const inTenant = <T>(work: () => Promise<T>) =>
      app.get(Tenancy).run(tenantId, work);
    const survivor = await createTestItem(app, admin.headers, {
      title: 'Acme',
    });
    // The editor made it: they watch it.
    const duplicate = await createTestItem(app, editor.headers, {
      title: 'Acme',
    });
    const tag = await call('POST', '/v1/tags', admin.headers, {
      subject: 'TestItem',
      name: 'vip',
    });
    expect(tag.statusCode, tag.body).toBe(201);
    expect(
      (
        await call(
          'PUT',
          `/v1/test-items/${duplicate.id}/tags`,
          admin.headers,
          {
            tagIds: [tag.json().id],
          },
        )
      ).statusCode,
    ).toBe(200);
    const comment = await call(
      'POST',
      `/v1/test-items/${duplicate.id}/comments`,
      admin.headers,
      { body: 'Same customer' },
    );
    expect(comment.statusCode, comment.body).toBe(201);
    await inTenant(() =>
      db.insert(attachments).values({
        subject: 'TestItem',
        recordId: duplicate.id,
        key: `tenants/${tenantId}/merge-test`,
        name: 'contract.pdf',
        size: 10,
        contentType: 'application/pdf',
        uploadedBy: `user:${admin.id}`,
      }),
    );
    expect(
      (
        await call('POST', '/v1/favorites', admin.headers, {
          kind: 'record',
          subject: 'TestItem',
          target: duplicate.id,
          label: 'Acme',
        })
      ).statusCode,
    ).toBe(201);

    const merged = await call(
      'POST',
      `/v1/test-items/${survivor.id}/merge`,
      admin.headers,
      { duplicateId: duplicate.id },
    );
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json().tags).toEqual([
      expect.objectContaining({ id: tag.json().id }),
    ]);
    const comments = await call(
      'GET',
      `/v1/test-items/${survivor.id}/comments`,
      admin.headers,
    );
    expect(comments.json().items.map((c: { body: string }) => c.body)).toEqual([
      'Same customer',
    ]);
    const files = await inTenant(() =>
      db
        .select({ recordId: attachments.recordId })
        .from(attachments)
        .where(eq(attachments.name, 'contract.pdf')),
    );
    expect(files).toEqual([{ recordId: survivor.id }]);
    const favorites = (await call('GET', '/v1/favorites', admin.headers)).json()
      .items as { target: string }[];
    expect(favorites.map((f) => f.target)).toEqual([survivor.id]);
    const watchers = await inTenant(() =>
      db
        .select({ subscriber: recordSubscriptions.subscriber })
        .from(recordSubscriptions)
        .where(eq(recordSubscriptions.recordId, survivor.id)),
    );
    expect(watchers.map((w) => w.subscriber).sort()).toEqual(
      [`user:${admin.id}`, `user:${editor.id}`].sort(),
    );
  });
});
