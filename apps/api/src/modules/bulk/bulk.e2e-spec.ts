import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import {
  createTestItem,
  type Headers,
  type Member,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { BulkModule } from './bulk.module.js';
import { BULK } from './bulk.types.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.APP_ROLE = 'all';
  process.env.BULK_SYNC_LIMIT = '5';
  process.env.REDIS_PREFIX = `test-bulk-${process.pid}-${Date.now()}`;
});

/**
 * Bulk operations (README.md) on the test items: each item goes through the
 * record's store (permission, hooks, legal hold, audit), small runs answer
 * in the request, larger ones and filters are jobs with progress.
 */
describe('bulk operations (e2e)', () => {
  let app: NestNodeApplication;
  let queue: Queue;
  let tenantId: string;
  let admin: Member;
  let editor: Member;
  let other: Member;
  let viewer: Member;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      testItemsModule({ imports: [BulkModule.forRecord(TEST_ITEM)] }),
    );
    queue = app.get(getQueueToken(BULK));
    await queue.obliterate({ force: true });
    ({ tenantId, admin, editor, other, viewer } = await recordsTenant(app));
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const bulk = (headers: Headers, payload: object) =>
    call('POST', '/v1/test-items/bulk', headers, payload);
  const create = (headers: Headers, body: object = {}) =>
    createTestItem(app, headers, body);
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);

  /** A queued run, followed until it ends. */
  async function finished(headers: Headers, id: string) {
    for (let i = 0; i < 200; i++) {
      const run = (await call('GET', `/v1/bulk/${id}`, headers)).json();
      if (run.status === 'completed' || run.status === 'failed') return run;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Bulk run ${id} did not end.`);
  }

  it('deletes the ids you may delete, skips the others, and answers a result per id in order', async () => {
    const [a, b] = [await create(editor.headers), await create(editor.headers)];
    const theirs = await create(other.headers);
    const missing = randomUUID();
    const ids = [a.id, theirs.id, missing, b.id];
    const response = await bulk(editor.headers, { action: 'delete', ids });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json();
    expect(result).toMatchObject({ done: 2, failed: 0, skipped: 2 });
    expect(result.results.map((r: { id: string }) => r.id)).toEqual(ids);
    expect(result.results[1]).toMatchObject({
      status: 'skipped',
      error: { code: 'not_found' },
    });
    expect(
      (await call('GET', `/v1/test-items/${a.id}`, editor.headers)).statusCode,
    ).toBe(404);
    // Theirs is untouched.
    expect(
      (await call('GET', `/v1/test-items/${theirs.id}`, other.headers))
        .statusCode,
    ).toBe(200);
    // The record's own audit entry, per item, then the run's.
    const entries = await inTenant(() =>
      db()
        .select({ action: auditLog.action, runId: auditLog.runId })
        .from(auditLog)
        .where(eq(auditLog.targetId, a.id)),
    );
    const deleted = entries.find((e) => e.action === 'testItem.deleted');
    // Stamped with the run, whose start names it.
    const [start] = await inTenant(() =>
      db()
        .select({ targetId: auditLog.targetId })
        .from(auditLog)
        .where(eq(auditLog.action, 'bulk.started')),
    ).then((rows) => rows.filter((row) => row.targetId === deleted?.runId));
    expect(deleted?.runId).toBeTruthy();
    expect(start).toBeDefined();
  });

  it('changes records with the one input, failing an item alone with its own 4xx (a record others refer to)', async () => {
    const parent = await create(editor.headers);
    await create(editor.headers, { parentId: parent.id });
    const plain = await create(editor.headers);
    const response = await bulk(editor.headers, {
      action: 'delete',
      ids: [parent.id, plain.id],
    });
    expect(response.json()).toMatchObject({ done: 1, failed: 1 });
    expect(
      response.json().results.find((r: { id: string }) => r.id === parent.id),
    ).toMatchObject({
      status: 'failed',
      error: { code: 'record_referenced' },
    });

    const updated = await bulk(editor.headers, {
      action: 'update',
      ids: [parent.id],
      input: { status: 'done' },
    });
    expect(updated.json()).toMatchObject({ done: 1 });
    const read = await call(
      'GET',
      `/v1/test-items/${parent.id}`,
      editor.headers,
    );
    expect(read.json().status).toBe('done');
    // The feature's own write logic runs too: `words` is counted again.
    await bulk(editor.headers, {
      action: 'update',
      ids: [parent.id],
      input: { body: 'four words right here' },
    });
    expect(
      (await call('GET', `/v1/test-items/${parent.id}`, editor.headers)).json()
        .words,
    ).toBe(4);
  });

  it('restores deleted records', async () => {
    const item = await create(editor.headers);
    await call('DELETE', `/v1/test-items/${item.id}`, editor.headers);
    const response = await bulk(editor.headers, {
      action: 'restore',
      ids: [item.id],
    });
    expect(response.json()).toMatchObject({ done: 1 });
    expect(
      (await call('GET', `/v1/test-items/${item.id}`, editor.headers))
        .statusCode,
    ).toBe(200);
  });

  it('fails a delete of a record under a legal hold, the rest of the run goes on', async () => {
    const held = await create(editor.headers);
    const free = await create(editor.headers);
    await call('POST', '/v1/legal-holds', admin.headers, {
      subject: 'TestItem',
      recordId: held.id,
      reason: 'Litigation',
    });
    const response = await bulk(editor.headers, {
      action: 'delete',
      ids: [held.id, free.id],
    });
    expect(response.json()).toMatchObject({ done: 1, failed: 1 });
    expect(
      response.json().results.find((r: { id: string }) => r.id === held.id)
        .error.code,
    ).toBe('legal_hold');
  });

  it('refuses what the request gets wrong', async () => {
    const id = randomUUID();
    const code = async (headers: Headers, payload: object) => {
      const response = await bulk(headers, payload);
      return [response.statusCode, response.json().code];
    };
    // No permission for the action at all.
    expect(
      (await bulk(viewer.headers, { action: 'delete', ids: [id] })).statusCode,
    ).toBe(403);
    expect(await code(editor.headers, { action: 'delete' })).toEqual([
      400,
      'validation_failed',
    ]);
    expect(
      await code(editor.headers, {
        action: 'delete',
        ids: [id],
        filter: { status: 'draft' },
      }),
    ).toEqual([400, 'validation_failed']);
    expect(
      await code(editor.headers, { action: 'explode', ids: [id] }),
    ).toEqual([400, 'validation_failed']);
    expect(
      await code(editor.headers, {
        action: 'delete',
        ids: [id],
        input: { status: 'done' },
      }),
    ).toEqual([400, 'validation_failed']);
    expect(
      await code(editor.headers, {
        action: 'update',
        ids: [id],
        input: { status: 'nope' },
      }),
    ).toEqual([400, 'validation_failed']);
    expect(
      await code(editor.headers, {
        action: 'delete',
        ids: Array.from({ length: 501 }, () => randomUUID()),
      }),
    ).toEqual([400, 'bulk_too_many']);
    // A filter takes conditions only: paging and the bin are no filters.
    expect(
      await code(editor.headers, { action: 'delete', filter: { limit: 2 } }),
    ).toEqual([400, 'validation_failed']);
    expect(
      await code(editor.headers, { action: 'delete', filter: {} }),
    ).toEqual([400, 'validation_failed']);
    expect((await call('POST', '/v1/test-items/bulk', {})).statusCode).toBe(
      401,
    );
  });

  it('hands a filter, and more ids than BULK_SYNC_LIMIT, to a job with progress, its result and the run list', async () => {
    const mark = `bulk-${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 3; i++)
      await create(editor.headers, { code: `${mark}-${i}` });
    const kept = await create(other.headers, { code: `${mark}-keep` });

    const started = await bulk(editor.headers, {
      action: 'update',
      filter: { 'code.startsWith': mark },
      input: { status: 'done' },
    });
    expect(started.statusCode, started.body).toBe(202);
    const run = await finished(editor.headers, started.json().id);
    expect(run).toMatchObject({
      status: 'completed',
      subject: 'TestItem',
      action: 'update',
      progress: { processed: 3, done: 3, failed: 0 },
      result: { done: 3, failed: 0 },
    });
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    // The editor's own only: the other editor's record matched the filter, not the permission.
    const stillDraft = await call(
      'GET',
      `/v1/test-items/${kept.id}`,
      other.headers,
    );
    expect(stillDraft.json().status).toBe('draft');
    // The run's items carry its id: the record list and the audit log expand it.
    const changed = await call(
      'GET',
      `/v1/test-items?bulkRun=${started.json().id}`,
      editor.headers,
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(
      changed
        .json()
        .items.map((item: { code: string }) => item.code)
        .sort(),
    ).toEqual([0, 1, 2].map((i) => `${mark}-${i}`));

    // More ids than the synchronous limit (5): a job as well.
    const many = await Promise.all(
      Array.from({ length: 6 }, () => create(editor.headers)),
    );
    const bigger = await bulk(editor.headers, {
      action: 'delete',
      ids: many.map((item) => item.id),
    });
    expect(bigger.statusCode).toBe(202);
    const ended = await finished(editor.headers, bigger.json().id);
    expect(ended.result).toMatchObject({ done: 6 });

    const listed = (await call('GET', '/v1/bulk', editor.headers)).json();
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([
      bigger.json().id,
      started.json().id,
    ]);
    expect(listed.items[0].result).not.toHaveProperty('results');
    const deletes = (
      await call('GET', '/v1/bulk?kind=delete', editor.headers)
    ).json();
    expect(deletes.items).toHaveLength(1);
    expect(
      (await call('GET', '/v1/bulk?status=failed', editor.headers)).json()
        .items,
    ).toEqual([]);

    // Only the principal who started it sees it, and never in another tenant.
    expect(
      (await call('GET', `/v1/bulk/${started.json().id}`, other.headers))
        .statusCode,
    ).toBe(404);
    expect((await call('GET', '/v1/bulk', other.headers)).json().items).toEqual(
      [],
    );
    const elsewhere = await tenantWithAdmin(app);
    expect(
      (
        await call(
          'GET',
          `/v1/bulk/${started.json().id}`,
          elsewhere.admin.headers,
        )
      ).statusCode,
    ).toBe(404);
    const audited = await inTenant(() =>
      db()
        .select({ action: auditLog.action, runId: auditLog.runId })
        .from(auditLog)
        .where(eq(auditLog.targetId, started.json().id)),
    );
    // The start is the run's line (no run id); its end and its items are in it.
    expect(audited.sort((x, y) => x.action.localeCompare(y.action))).toEqual([
      { action: 'bulk.finished', runId: started.json().id },
      { action: 'bulk.started', runId: null },
    ]);
    const items = await inTenant(() =>
      db()
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(eq(auditLog.runId, started.json().id)),
    );
    expect(items.map((e) => e.action).sort()).toEqual([
      'bulk.finished',
      'testItem.updated',
      'testItem.updated',
      'testItem.updated',
    ]);
  });

  it('closes a run that fails for good with bulk.failed, in the run', async () => {
    // A principal who no longer acts in the run's tenant: the worker refuses it.
    const job = await queue.add(
      'TestItem',
      {
        tenantId,
        principal: {
          kind: 'user',
          id: editor.id,
          name: 'Gone',
          email: 'gone@example.com',
          emailVerified: true,
          locale: null,
          timezone: null,
          tenantId: randomUUID(),
        },
        subject: 'TestItem',
        action: 'delete',
        ids: [randomUUID()],
      },
      { jobId: randomUUID(), attempts: 1 },
    );
    let entries: { action: string; runId: string | null; details: unknown }[] =
      [];
    for (let i = 0; i < 100 && entries.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      entries = await inTenant(() =>
        db()
          .select({
            action: auditLog.action,
            runId: auditLog.runId,
            details: auditLog.details,
          })
          .from(auditLog)
          .where(eq(auditLog.targetId, job.id!)),
      );
    }
    expect(entries).toEqual([
      {
        action: 'bulk.failed',
        runId: job.id,
        details: {
          subject: 'TestItem',
          action: 'delete',
          reason: 'The account that started this bulk run is no longer active.',
        },
      },
    ]);
  });

  it('says it takes bulk in the list description, and refuses a filter the list does not declare', async () => {
    const lists = await call('GET', '/v1/lists/TestItem', editor.headers);
    expect(lists.json().capabilities).toMatchObject({ bulk: true });
    const response = await bulk(editor.headers, {
      action: 'delete',
      filter: { nonsense: 'x' },
    });
    expect(response.statusCode).toBe(400);
  });
});
