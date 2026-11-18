import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
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
import { auditLog } from '../../iam/audit/audit.tables.js';
import { getQueueToken } from '@nestjs/bullmq';
import { OutboxRelay } from '@nestjs/outbox';
import type { Queue } from 'bullmq';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { AutomationsModule } from '../automations/automations.module.js';
import { PUSH_QUEUE } from '../notifications/notifications.push.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { TagsModule } from './tags.module.js';
import { TAGS_RESPONSE } from './tags.schemas.js';
import { recordTags } from './tags.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    OUTBOX_RELAY: 'off',
    WEBHOOKS_WORKER: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-tags-${process.pid}:`,
  });
});

describe('tags (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      WebhooksModule,
      AutomationsModule,
      testItemsModule({
        imports: [
          TagsModule.forRecord(TEST_ITEM),
          AutomationsModule.forRecord(TEST_ITEM),
        ],
        response: TAGS_RESPONSE,
      }),
    );
  });
  afterAll(async () => {
    if (!app) return;
    for (const name of [MAIL_QUEUE, PUSH_QUEUE]) {
      await app.get<Queue>(getQueueToken(name)).obliterate({ force: true });
    }
    await app.close();
  });
  // A tenant of its own per test: tag names and counts are per tenant.
  beforeEach(async () => {
    team = await recordsTenant(app);
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);
  const names = (tags: { name: string }[]) => tags.map((tag) => tag.name);
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(fn: () => Promise<T>) =>
    app.get(Tenancy).run(team.tenantId, fn);

  /** A TestItem tag, made by the administrator. */
  async function tag(name: string, color?: string) {
    const created = await call('POST', '/v1/tags', team.admin.headers, {
      subject: 'TestItem',
      name,
      ...(color && { color }),
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json<{ id: string; name: string; color: string | null }>();
  }
  const set = (headers: Headers, id: string, tagIds: string[]) =>
    call('PUT', `/v1/test-items/${id}/tags`, headers, { tagIds });
  const audited = (action: string, targetId: string) =>
    inTenant(() =>
      db()
        .select({ details: auditLog.details, targetType: auditLog.targetType })
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)),
        )
        .orderBy(auditLog.at),
    );

  it('lets only tag managers create, change and delete tags; anyone signed in reads them', async () => {
    for (const someone of [team.editor, team.viewer]) {
      const refused = await call('POST', '/v1/tags', someone.headers, {
        subject: 'TestItem',
        name: 'Nope',
      });
      expect(refused.statusCode).toBe(403);
    }

    const created = await call('POST', '/v1/tags', team.admin.headers, {
      subject: 'TestItem',
      name: 'Urgent',
      color: '#FF0000',
      description: 'Do it now',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      subject: 'TestItem',
      name: 'Urgent',
      color: '#ff0000',
      description: 'Do it now',
    });
    const id = created.json<{ id: string }>().id;

    expect(
      (
        await call('PATCH', `/v1/tags/${id}`, team.editor.headers, {
          name: 'x',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', `/v1/tags/${id}`, team.viewer.headers)).statusCode,
    ).toBe(403);

    // The same name in another case: taken.
    const duplicate = await call('POST', '/v1/tags', team.admin.headers, {
      subject: 'TestItem',
      name: 'URGENT',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('tag_taken');

    const bad = await call('POST', '/v1/tags', team.admin.headers, {
      subject: 'TestItem',
      name: 'Red',
      color: 'red',
    });
    expect(bad.statusCode).toBe(400);
    expect(paths(bad.json())).toEqual(['color']);
    const unknown = await call('POST', '/v1/tags', team.admin.headers, {
      subject: 'Invoice',
      name: 'Paid',
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe('validation_failed');
    expect(paths(unknown.json())).toEqual(['subject']);

    const later = await tag('Later');
    const renamed = await call('PATCH', `/v1/tags/${id}`, team.admin.headers, {
      name: 'Critical',
      color: null,
    });
    expect(renamed.json()).toMatchObject({ name: 'Critical', color: null });
    expect(
      (
        await call('PATCH', `/v1/tags/${later.id}`, team.admin.headers, {
          name: 'critical',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await call('PATCH', `/v1/tags/${randomUUID()}`, team.admin.headers, {
          name: 'Gone',
        })
      ).statusCode,
    ).toBe(404);

    // Reading: everyone; filters by subject and name.
    const read = async (query: string, headers = team.viewer.headers) =>
      names((await call('GET', `/v1/tags${query}`, headers)).json().items);
    expect(await read('?subject=TestItem')).toEqual(['Later', 'Critical']);
    expect(await read('?sort=name', team.editor.headers)).toEqual([
      'Critical',
      'Later',
    ]);
    expect(await read('?name.contains=RIT')).toEqual(['Critical']);
    expect(await read('?name=later')).toEqual(['Later']);
    expect(await read('?subject=Invoice')).toEqual([]);

    expect(
      (await call('DELETE', `/v1/tags/${later.id}`, team.admin.headers))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('DELETE', `/v1/tags/${later.id}`, team.admin.headers))
        .statusCode,
    ).toBe(404);

    expect(await audited('tag.created', id)).toHaveLength(1);
    expect((await audited('tag.updated', id))[0]!.details).toEqual({
      changes: {
        name: { from: 'Urgent', to: 'Critical' },
        color: { from: '#ff0000', to: null },
      },
    });
    expect(await audited('tag.deleted', later.id)).toHaveLength(1);
  });

  it('tags test items: those who may change one set its tags; test items show and filter by them', async () => {
    const [urgent, later] = [
      await tag('Urgent', '#ff0000'),
      await tag('Later'),
    ];
    const first = (
      await createTestItem(app, team.editor.headers, { title: 'First' })
    ).id;
    const second = (
      await createTestItem(app, team.editor.headers, { title: 'Second' })
    ).id;
    await createTestItem(app, team.editor.headers, { title: 'Untagged' });

    const answer = await set(team.editor.headers, first, [later.id, urgent.id]);
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json().items).toEqual([
      { id: later.id, name: 'Later', color: null },
      { id: urgent.id, name: 'Urgent', color: '#ff0000' },
    ]);
    // usageCount: the records carrying each tag.
    const counted = await call(
      'GET',
      '/v1/tags?subject=TestItem',
      team.editor.headers,
    );
    const usage = Object.fromEntries(
      counted
        .json()
        .items.map((t: { id: string; usageCount: number }) => [
          t.id,
          t.usageCount,
        ]),
    );
    expect(usage[later.id]).toBe(1);
    expect(usage[urgent.id]).toBe(1);

    // Tags are part of the test item's representation: its ETag moves with them.
    const stale = (
      await call('GET', `/v1/test-items/${second}`, team.editor.headers)
    ).headers.etag as string;
    await set(team.editor.headers, second, [later.id]);
    const fresh = (
      await call('GET', `/v1/test-items/${second}`, team.editor.headers)
    ).headers.etag as string;
    expect(fresh).not.toBe(stale);
    expect(
      (
        await call(
          'PATCH',
          `/v1/test-items/${second}`,
          { ...team.editor.headers, 'if-match': stale },
          { title: 'Second!' },
        )
      ).statusCode,
    ).toBe(412);

    // The viewer reads test items but may not change them; another editor can't read them at all.
    expect((await set(team.viewer.headers, first, [])).statusCode).toBe(403);
    expect((await set(team.other.headers, first, [])).statusCode).toBe(404);
    expect((await set(team.editor.headers, randomUUID(), [])).statusCode).toBe(
      404,
    );

    // A tag that doesn't exist: named by its path.
    const missing = await set(team.editor.headers, first, [
      urgent.id,
      randomUUID(),
    ]);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('validation_failed');
    expect(paths(missing.json())).toEqual(['tagIds.1']);
    expect(
      (await set(team.editor.headers, first, ['not-a-uuid'])).statusCode,
    ).toBe(400);

    // The test item and the list carry them.
    const one = await call(
      'GET',
      `/v1/test-items/${first}`,
      team.editor.headers,
    );
    expect(names(one.json().tags)).toEqual(['Later', 'Urgent']);
    const list = await call('GET', '/v1/test-items', team.viewer.headers);
    const byTitle = Object.fromEntries(
      list
        .json()
        .items.map((item: { title: string; tags: { name: string }[] }) => [
          item.title,
          names(item.tags),
        ]),
    );
    expect(byTitle).toEqual({
      First: ['Later', 'Urgent'],
      Second: ['Later'],
      Untagged: [],
    });
    const picked = await call(
      'GET',
      '/v1/test-items?fields=tags',
      team.viewer.headers,
    );
    expect(Object.keys(picked.json().items[0]).sort()).toEqual(['id', 'tags']);

    // Filters: one tag, any of several.
    const titles = async (query: string) =>
      (await call('GET', `/v1/test-items${query}`, team.viewer.headers))
        .json()
        .items.map((item: { title: string }) => item.title);
    expect(await titles(`?tag=${urgent.id}`)).toEqual(['First']);
    expect((await titles(`?tag=${later.id}`)).sort()).toEqual([
      'First',
      'Second',
    ]);
    expect((await titles(`?tag.in=${urgent.id},${later.id}`)).sort()).toEqual([
      'First',
      'Second',
    ]);
    expect(
      await titles(
        `?filter=${encodeURIComponent(JSON.stringify({ field: 'tag', op: 'eq', value: urgent.id }))}`,
      ),
    ).toEqual(['First']);
    expect(
      (await call('GET', '/v1/test-items?tag=nope', team.viewer.headers))
        .statusCode,
    ).toBe(400);

    // Replacing the set; then deleting a tag removes it from every test item.
    await set(team.editor.headers, second, [urgent.id]);
    const tagsOf = async (id: string) =>
      (await call('GET', `/v1/test-items/${id}`, team.editor.headers)).json()
        .tags;
    expect(names(await tagsOf(second))).toEqual(['Urgent']);
    await call('DELETE', `/v1/tags/${urgent.id}`, team.admin.headers);
    expect(await tagsOf(second)).toEqual([]);
    expect(names(await tagsOf(first))).toEqual(['Later']);
    expect(await titles(`?tag=${urgent.id}`)).toEqual([]);

    // One audit entry per change of a test item's set, from and to.
    const changes = await audited('tags.changed', second);
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      targetType: 'testItem',
      details: {
        subject: 'TestItem',
        from: [later.id],
        to: [urgent.id],
        added: [urgent.id],
        removed: [later.id],
      },
    });
    // The same set again changes nothing and audits nothing.
    await set(team.editor.headers, second, []);
    expect(await audited('tags.changed', second)).toHaveLength(2);
  });

  it('forgets the tags of a test item deleted for good', async () => {
    const urgent = await tag('Urgent');
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Gone',
    });
    await set(team.editor.headers, item.id, [urgent.id]);
    await call('DELETE', `/v1/test-items/${item.id}`, team.editor.headers);
    await inTenant(() =>
      db()
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(inArray(testItems.id, [item.id])),
    );
    expect(await app.get(RecycleBinPurgeJob).run()).toBeGreaterThanOrEqual(1);
    const links = await inTenant(() =>
      db().select().from(recordTags).where(eq(recordTags.recordId, item.id)),
    );
    expect(links).toEqual([]);
  });

  it("keeps tenants apart: another tenant's tags are not this one's", async () => {
    await tag('Urgent');
    const other = await tenantWithAdmin(app);
    const list = await call('GET', '/v1/tags', other.admin.headers);
    expect(list.json().items).toEqual([]);
  });

  it("adds a tag as an automation's addTag action", async () => {
    const tag = (
      await call('POST', '/v1/tags', team.admin.headers, {
        subject: 'TestItem',
        name: 'Urgent',
      })
    ).json<{ id: string }>();
    const definition = {
      name: 'Tag urgent',
      subject: 'TestItem',
      trigger: 'created',
      condition: "status == 'done'",
      actions: [{ type: 'addTag', tagId: tag.id }],
    };
    // A tag that is not the subject's is refused when the rule is saved.
    const unknown = await call(
      'POST',
      '/v1/automation-rules',
      team.admin.headers,
      {
        ...definition,
        actions: [{ type: 'addTag', tagId: randomUUID() }],
      },
    );
    expect(unknown.statusCode).toBe(400);
    const created = await call(
      'POST',
      '/v1/automation-rules',
      team.admin.headers,
      definition,
    );
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<{ id: string }>();
    expect(
      (
        await call(
          'POST',
          `/v1/automation-rules/${id}/activate`,
          team.admin.headers,
        )
      ).statusCode,
    ).toBe(200);

    const done = await createTestItem(app, team.admin.headers, {
      status: 'done',
    });
    const other = await createTestItem(app, team.admin.headers, {});
    await app.get(OutboxRelay).runOnce();
    const tagsOf = async (itemId: string) =>
      (await call('GET', `/v1/test-items/${itemId}`, team.admin.headers))
        .json<{ tags: { name: string }[] }>()
        .tags.map((t) => t.name);
    expect(await tagsOf(done.id)).toEqual(['Urgent']);
    expect(await tagsOf(other.id)).toEqual([]);
  });

  // modules/merge calls the hook; its test of every hook is its own.
  it("moves a merged duplicate's tags to the survivor (RecordHooks.merged)", async () => {
    const survivor = await createTestItem(app, team.admin.headers);
    const duplicate = await createTestItem(app, team.admin.headers);
    const vip = await tag('vip');
    expect(
      (await set(team.admin.headers, duplicate.id, [vip.id])).statusCode,
    ).toBe(200);
    await mergeTestItems(app, team.tenantId, duplicate.id, survivor.id);
    const read = await call(
      'GET',
      `/v1/test-items/${survivor.id}`,
      team.admin.headers,
    );
    expect(names(read.json().tags)).toEqual(['vip']);
  });
});
