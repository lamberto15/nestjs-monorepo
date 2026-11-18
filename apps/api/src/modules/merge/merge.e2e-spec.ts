import { randomUUID } from 'node:crypto';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { testRecordMarks } from '../../../test/fixtures/test-items/marks/marks.tables.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  type Member,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { defineEvent, OnDomainEvent } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { tenantWithAdmin } from '../../../test/access.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import type { RecordMergedPayload } from './merge.events.js';
import { MergeModule } from './merge.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-merge-${process.pid}:`;
});

/**
 * What an add-on that keeps rows about a record does to take part in a
 * merge: it subscribes to `<item>.merged`, with no import of the merge module.
 */
@Injectable()
class MarksFollowMerge {
  constructor(@InjectTransaction() private readonly db: Database) {}

  @OnDomainEvent(defineEvent<RecordMergedPayload>('testItem.merged'), {
    consumer: 'test-marks-merge',
  })
  async moved({ id, duplicateId }: RecordMergedPayload) {
    await this.db
      .update(testRecordMarks)
      .set({ recordId: id })
      .where(
        and(
          eq(testRecordMarks.subject, 'TestItem'),
          eq(testRecordMarks.recordId, duplicateId),
        ),
      );
  }
}

@Module({ providers: [MarksFollowMerge] })
class MarksFollowModule {}

/** Each merge the add-ons were told of (RecordHooks.merged), from → to. */
const told: [string, string][] = [];

/**
 * An add-on's `merged` hook, as tags, comments, attachments, favorites and
 * watchers have: run in the merge's transaction. Each add-on tests its own
 * hook (test/records.ts, mergeTestItems); this proves the merge calls it.
 */
@RecordExtension()
@Injectable()
class MergedHookProbe implements RecordHooks {
  constructor(@InjectRecord() readonly record: RecordDeclaration) {}

  merged({ from, to }: { from: RecordRow; to: RecordRow }) {
    told.push([from.id, to.id]);
    return Promise.resolve();
  }
}

@Module({})
class MergedHookHost {}
const mergedHook: DynamicModule = {
  module: MergedHookHost,
  imports: [RecordsModule],
  providers: [{ provide: RECORD, useValue: TEST_ITEM }, MergedHookProbe],
};

describe('merging duplicates (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Member;
  let editor: Member;
  let viewer: Member;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      MarksFollowModule,
      testItemsModule({
        imports: [MergeModule.forRecord(TEST_ITEM), mergedHook],
      }),
    );
    ({ tenantId, admin, editor, viewer } = await recordsTenant(app));
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const item = (body: object, headers = admin.headers) =>
    createTestItem(app, headers, body);
  const merge = (
    id: string,
    body: object,
    path = 'merge',
    headers = admin.headers,
  ) => call('POST', `/v1/test-items/${id}/${path}`, headers, body);
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);

  it('finds duplicates by the title, before a create and for a record, among readable ones', async () => {
    const title = `Acme ${randomUUID().slice(0, 6)}`;
    const first = await item({ title });
    const second = await item({ title: `  ${title.toUpperCase()} ` });
    await item({ title: 'Other' });

    const before = await call(
      'POST',
      '/v1/test-items/duplicates',
      admin.headers,
      {
        values: { title: title.toLowerCase() },
      },
    );
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().items.map((d: { id: string }) => d.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(before.json().items[0].matched).toEqual([['title']]);

    const of = await call(
      'GET',
      `/v1/test-items/${first.id}/duplicates`,
      admin.headers,
    );
    expect(of.json().items.map((d: { id: string }) => d.id)).toEqual([
      second.id,
    ]);

    // Nothing to match by: nothing found.
    const none = await call(
      'POST',
      '/v1/test-items/duplicates',
      admin.headers,
      {
        values: { body: 'x' },
      },
    );
    expect(none.json().items).toEqual([]);

    // Only what the caller may read: the other editor's records are not theirs.
    const mine = await item({ title }, editor.headers);
    const asEditor = await call(
      'POST',
      '/v1/test-items/duplicates',
      editor.headers,
      {
        values: { title },
      },
    );
    expect(asEditor.json().items.map((d: { id: string }) => d.id)).toEqual([
      mine.id,
    ]);

    // Another tenant's record is never a duplicate.
    const elsewhere = await tenantWithAdmin(app);
    const foreign = await call(
      'POST',
      '/v1/test-items/duplicates',
      elsewhere.admin.headers,
      {
        values: { title },
      },
    );
    expect(foreign.json().items).toEqual([]);
  });

  it('previews, then merges: chosen values, references, the duplicate in the bin, add-ons following; audited', async () => {
    const title = `Merge ${randomUUID().slice(0, 6)}`;
    const survivor = await item({ title, body: 'Old' });
    const code = `C-${randomUUID()}`;
    const duplicate = await item({ title, body: 'New', code });
    const child = await item({ title: 'Child', parentId: duplicate.id });
    await inTenant(() =>
      db()
        .insert(testRecordMarks)
        .values({ subject: 'TestItem', recordId: duplicate.id, mark: 'vip' }),
    );

    const body = {
      duplicateId: duplicate.id,
      fields: { body: 'duplicate', code: 'duplicate' },
    };
    const preview = await merge(survivor.id, body, 'merge/preview');
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().result).toMatchObject({ title, body: 'New' });
    expect(preview.json().fields).toContainEqual({
      name: 'body',
      survivor: 'Old',
      duplicate: 'New',
      differs: true,
      keep: 'duplicate',
    });
    expect(preview.json().moves.references).toEqual([
      { subject: 'TestItem', field: 'parentId', count: 1 },
    ]);
    // A preview changes nothing.
    expect(
      (await call('GET', `/v1/test-items/${duplicate.id}`, admin.headers))
        .statusCode,
    ).toBe(200);

    const merged = await merge(survivor.id, body);
    expect(merged.statusCode, merged.body).toBe(200);
    expect(merged.json()).toMatchObject({
      id: survivor.id,
      title,
      body: 'New',
      code,
    });
    expect(
      (await call('GET', `/v1/test-items/${duplicate.id}`, admin.headers))
        .statusCode,
    ).toBe(404);
    const moved = await call(
      'GET',
      `/v1/test-items/${child.id}`,
      admin.headers,
    );
    expect(moved.json().parentId).toBe(survivor.id);

    const entries = await inTenant(() =>
      db()
        .select({ action: auditLog.action, details: auditLog.details })
        .from(auditLog)
        .where(eq(auditLog.targetId, survivor.id)),
    );
    const entry = entries.find((e) => e.action === 'testItem.merged');
    expect(entry?.details).toMatchObject({
      duplicateId: duplicate.id,
      fields: ['body', 'code'],
      references: [{ subject: 'TestItem', field: 'parentId', ids: [child.id] }],
    });
    // The record's own entries, from its store.
    expect(entries.map((e) => e.action)).toContain('testItem.updated');

    // The add-on follows after the commit, from the event.
    await vi.waitFor(
      async () => {
        const rows = await inTenant(() =>
          db()
            .select()
            .from(testRecordMarks)
            .where(eq(testRecordMarks.recordId, survivor.id)),
        );
        expect(rows.map((r) => r.mark)).toEqual(['vip']);
      },
      { timeout: 20_000, interval: 200 },
    );

    // Done once: a repeat finds the duplicate gone. Restoring it is refused
    // while the survivor holds its unique code.
    expect((await merge(survivor.id, body)).statusCode).toBe(404);
    const restore = await call(
      'POST',
      `/v1/test-items/${duplicate.id}/restore`,
      admin.headers,
    );
    expect(restore.statusCode).toBe(409);
    expect(restore.json().code).toBe('testItem_taken');
  });

  it('takes changing every record referring to the duplicate, in the recycle bin too', async () => {
    const title = `Own ${randomUUID().slice(0, 6)}`;
    const survivor = await item({ title }, editor.headers);
    const duplicate = await item({ title }, editor.headers);
    // Someone else's record refers to the duplicate, then goes to the bin.
    const child = await item({ title: 'Child', parentId: duplicate.id });
    await call('DELETE', `/v1/test-items/${child.id}`, admin.headers);

    const refused = await merge(
      survivor.id,
      { duplicateId: duplicate.id },
      'merge',
      editor.headers,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('merge_references_forbidden');
    expect(
      (await call('GET', `/v1/test-items/${duplicate.id}`, editor.headers))
        .statusCode,
    ).toBe(200);

    // Whoever may change it merges, and the binned child follows the survivor.
    expect(
      (await merge(survivor.id, { duplicateId: duplicate.id })).statusCode,
    ).toBe(200);
    const restored = await call(
      'POST',
      `/v1/test-items/${child.id}/restore`,
      admin.headers,
    );
    expect(restored.json().parentId).toBe(survivor.id);
  });

  it('refuses what it should, changing nothing', async () => {
    const title = `Refuse ${randomUUID().slice(0, 6)}`;
    const survivor = await item({ title });
    const duplicate = await item({ title, body: 'Kept' });

    expect(
      (await merge(survivor.id, { duplicateId: survivor.id })).statusCode,
    ).toBe(422);
    expect(
      (
        await merge(
          survivor.id,
          { duplicateId: duplicate.id },
          'merge',
          viewer.headers,
        )
      ).statusCode,
    ).toBe(403);

    // The survivor would refer to the duplicate, about to go.
    const child = await item({ title, parentId: duplicate.id });
    const self = await merge(child.id, { duplicateId: duplicate.id });
    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe('merge_self_reference');

    // Under a legal hold, the duplicate stays.
    await call('POST', '/v1/legal-holds', admin.headers, {
      subject: 'TestItem',
      recordId: duplicate.id,
      reason: 'Case',
    });
    const held = await merge(survivor.id, {
      duplicateId: duplicate.id,
      fields: { body: 'duplicate' },
    });
    expect(held.statusCode).toBe(409);
    expect(held.json().code).toBe('legal_hold');
    const after = await call(
      'GET',
      `/v1/test-items/${survivor.id}`,
      admin.headers,
    );
    expect(after.json().body ?? null).toBeNull();
    const kept = await call('GET', `/v1/test-items/${child.id}`, admin.headers);
    expect(kept.json().parentId).toBe(duplicate.id);
  });

  it('says it takes merge in the list description; a record without a recycle bin cannot', async () => {
    const lists = await call('GET', '/v1/lists/TestItem', admin.headers);
    expect(lists.json().capabilities).toMatchObject({ merge: true });
    expect(() =>
      MergeModule.forRecord({ ...TEST_ITEM, softDelete: false }),
    ).toThrow(/softDelete/);
  });

  it("tells the add-ons' merged hooks, from the duplicate to the survivor", async () => {
    const title = `Hooked ${randomUUID()}`;
    const survivor = await item({ title });
    const duplicate = await item({ title });
    const merged = await merge(survivor.id, { duplicateId: duplicate.id });
    expect(merged.statusCode, merged.body).toBe(200);
    expect(told).toContainEqual([duplicate.id, survivor.id]);
  });
});
