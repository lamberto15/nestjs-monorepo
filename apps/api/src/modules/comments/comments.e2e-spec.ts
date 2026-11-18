import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { member } from '../../../test/access.js';
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
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { Realtime } from '../realtime/realtime.service.js';
import { recordSubscriptions } from '../notifications/notifications.tables.js';
import { RecycleBinPurgeJob } from '../records/recycle-bin.job.js';
import { CommentsModule } from './comments.module.js';
import { comments } from './comments.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-comments-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

interface Comment {
  id: string;
  author: string;
  authorName: string | null;
  body: string;
  mentions: string[];
  mentionNames: Record<string, string | null>;
  editedAt: string | null;
  parentId: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

interface Person {
  id: string;
  key: string;
  email: string;
  headers: Headers;
}

describe('comments on test items (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let counter = 0;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      testItemsModule({ imports: [CommentsModule.forRecord(TEST_ITEM)] }),
    );
    const team = await recordsTenant(app);
    tenantId = team.tenantId;
  });
  afterAll(async () => {
    await app?.close();
  });

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);
  const person = async (roles: string[], name: string): Promise<Person> => {
    const made = await member(app, tenantId, roles, {
      name,
      email: `${name.toLowerCase()}-${++counter}-${randomUUID().slice(0, 6)}@example.com`,
    });
    return { ...made, key: `user:${made.id}` };
  };
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const comment = async (
    who: Person,
    itemId: string,
    body: string,
    parentId?: string,
  ) => {
    const response = await call(
      'POST',
      `/v1/test-items/${itemId}/comments`,
      who.headers,
      { body, ...(parentId && { parentId }) },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Comment>();
  };
  /** What a feature's create does (subscribe its creator): the watch route. */
  const watch = async (who: Person, recordId: string) =>
    expect(
      (await call('PUT', `/v1/subscriptions/TestItem/${recordId}`, who.headers))
        .statusCode,
    ).toBe(204);
  const notified = async (who: Person, type: string) =>
    (await call('GET', `/v1/notifications?type=${type}`, who.headers)).json<{
      items: { title: string; body: string; link: string; data: object }[];
    }>().items;
  const auditOf = (action: string) =>
    inTenant(() =>
      db().select().from(auditLog).where(eq(auditLog.action, action)),
    );

  it('adds, lists, edits and removes comments; the author edits, the author or a moderator removes', async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const item = await createTestItem(app, owner.headers);
    const base = `/v1/test-items/${item.id}/comments`;

    const first = await comment(owner, item.id, '  First!  ');
    expect(first).toMatchObject({
      subject: 'TestItem',
      recordId: item.id,
      author: owner.key,
      authorName: 'Owen',
      body: 'First!',
      mentions: [],
      mentionNames: {},
      editedAt: null,
    });
    const second = await comment(viewer, item.id, 'Second');
    const third = await comment(owner, item.id, 'Third');

    // Oldest first, cursor pages; newest first on request.
    const ids = (response: { json<T>(): T }) =>
      response.json<{ items: Comment[] }>().items.map((c) => c.id);
    const page1 = await call(
      'GET',
      `${base}?limit=2&count=true`,
      viewer.headers,
    );
    expect(ids(page1)).toEqual([first.id, second.id]);
    expect(page1.json<{ total: number }>().total).toBe(3);
    const page2 = await call(
      'GET',
      `${base}?limit=2&cursor=${encodeURIComponent(page1.json<{ nextCursor: string }>().nextCursor)}`,
      viewer.headers,
    );
    expect(ids(page2)).toEqual([third.id]);
    expect(page2.json<{ nextCursor: unknown }>().nextCursor).toBeNull();
    const newest = await call(
      'GET',
      `${base}?sort=-createdAt&limit=2`,
      viewer.headers,
    );
    expect(ids(newest)).toEqual([third.id, second.id]);
    const rest = await call(
      'GET',
      `${base}?sort=-createdAt&limit=2&cursor=${encodeURIComponent(newest.json<{ nextCursor: string }>().nextCursor)}`,
      viewer.headers,
    );
    expect(ids(rest)).toEqual([first.id]);
    const byViewer = await call(
      'GET',
      `${base}?author=${viewer.key}&fields=body`,
      owner.headers,
    );
    expect(byViewer.json<{ items: unknown[] }>().items).toEqual([
      { id: second.id, body: 'Second' },
    ]);
    expect(
      page1
        .json<{ items: Comment[] }>()
        .items.map((c) => [c.author, c.authorName]),
    ).toEqual([
      [owner.key, 'Owen'],
      [viewer.key, 'Vera'],
    ]);

    // Who may not read the item sees none of it, nor writes: as if it didn't exist.
    expect((await call('GET', base, outsider.headers)).statusCode).toBe(404);
    expect(
      (await call('POST', base, outsider.headers, { body: 'Hi' })).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'GET',
          `/v1/test-items/${randomUUID()}/comments`,
          owner.headers,
        )
      ).statusCode,
    ).toBe(404);

    // Validation: empty, too long.
    for (const body of ['   ', 'x'.repeat(10_001)]) {
      const refused = await call('POST', base, owner.headers, { body });
      expect(refused.statusCode).toBe(400);
    }
    expect(
      (await call('POST', base, owner.headers, { body: 'x'.repeat(10_000) }))
        .statusCode,
    ).toBe(201);

    // Only the author edits.
    const edited = await call('PATCH', `${base}/${first.id}`, owner.headers, {
      body: 'First, edited',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json<Comment>()).toMatchObject({ body: 'First, edited' });
    expect(edited.json<Comment>().editedAt).not.toBeNull();
    expect(
      (
        await call('PATCH', `${base}/${first.id}`, viewer.headers, {
          body: 'Hijacked',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call('PATCH', `${base}/${randomUUID()}`, owner.headers, {
          body: 'Nope',
        })
      ).statusCode,
    ).toBe(404);

    // The viewer (no TestItem.update) can't remove the owner's; the owner (a moderator) removes the viewer's.
    expect(
      (await call('DELETE', `${base}/${third.id}`, viewer.headers)).statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', `${base}/${second.id}`, owner.headers)).statusCode,
    ).toBe(204);
    expect(
      (await call('DELETE', `${base}/${second.id}`, owner.headers)).statusCode,
    ).toBe(404);
    expect(
      (await call('DELETE', `${base}/${third.id}`, owner.headers)).statusCode,
    ).toBe(204);
    expect(ids(await call('GET', base, owner.headers))).toEqual([
      first.id,
      expect.any(String),
    ]);

    // Audited, the comment as target, the item in the details, never the text.
    for (const [action, id] of [
      ['comment.added', first.id],
      ['comment.edited', first.id],
      ['comment.removed', second.id],
    ] as const) {
      const entry = (await auditOf(action)).find((e) => e.targetId === id);
      expect(entry).toMatchObject({
        targetType: 'comment',
        details: expect.objectContaining({
          subject: 'TestItem',
          recordId: item.id,
        }),
      });
      expect(JSON.stringify(entry?.details)).not.toContain('Second');
    }
  });

  it('threads: one level of replies, resolve and reopen by the author or a moderator, filters, a thread removed with its replies', async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const item = await createTestItem(app, owner.headers, { title: 'Roadmap' });
    const base = `/v1/test-items/${item.id}/comments`;
    const reply = (who: Person, parentId: string, body: string) =>
      call('POST', base, who.headers, { body, parentId });

    const thread = await comment(viewer, item.id, 'Is this final?');
    const other = await comment(viewer, item.id, 'Another question');
    expect(thread).toMatchObject({ parentId: null, resolvedAt: null });
    const answer = (await reply(owner, thread.id, 'Yes.')).json<Comment>();
    expect(answer.parentId).toBe(thread.id);

    // Depth is one: no reply to a reply; the parent must be a comment of this record.
    expect((await reply(owner, answer.id, 'Nested')).statusCode).toBe(400);
    expect((await reply(owner, randomUUID(), 'Nobody')).statusCode).toBe(404);
    expect((await reply(outsider, thread.id, 'Hi')).statusCode).toBe(404);

    // The thread's author is told of the reply, once; not the replier; the watchers' notice skips them.
    expect(await notified(viewer, 'comment.replied')).toEqual([
      expect.objectContaining({
        title: 'Owen replied to your comment',
        link: `/test-items/${item.id}`,
      }),
    ]);
    expect(await notified(viewer, 'comment.added')).toEqual([]);
    expect(await notified(owner, 'comment.replied')).toEqual([]);

    const list = async (query: string) =>
      (await call('GET', `${base}?${query}`, viewer.headers))
        .json<{ items: Comment[] }>()
        .items.map((c) => c.id);
    expect(await list('')).toEqual([thread.id, other.id, answer.id]);
    expect(await list('parentId.isNull=true')).toEqual([thread.id, other.id]);
    expect(await list(`parentId=${thread.id}`)).toEqual([answer.id]);

    // Resolving: the thread's author or a moderator, not another reader; repeating changes nothing.
    expect((await reply(viewer, thread.id, 'Mine too')).statusCode).toBe(201);
    expect(
      (await call('POST', `${base}/${thread.id}/resolve`, outsider.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `${base}/${answer.id}/resolve`, owner.headers))
        .statusCode,
    ).toBe(400);
    const resolved = await call(
      'POST',
      `${base}/${thread.id}/resolve`,
      viewer.headers,
    );
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json<Comment>()).toMatchObject({
      resolvedBy: viewer.key,
      resolvedAt: expect.any(String),
    });
    expect(
      (await call('POST', `${base}/${thread.id}/resolve`, viewer.headers))
        .statusCode,
    ).toBe(200);
    expect(await list('resolvedAt.isNull=true&parentId.isNull=true')).toEqual([
      other.id,
    ]);
    // A resolved thread takes no reply until reopened.
    expect((await reply(owner, thread.id, 'Late')).statusCode).toBe(409);
    // A reader who isn't the author nor a moderator may not reopen it; the owner (a moderator) may.
    const reader = await person(['viewer'], 'Rhea');
    expect(
      (await call('POST', `${base}/${thread.id}/reopen`, reader.headers))
        .statusCode,
    ).toBe(403);
    const reopened = await call(
      'POST',
      `${base}/${thread.id}/reopen`,
      owner.headers,
    );
    expect(reopened.json<Comment>()).toMatchObject({
      resolvedAt: null,
      resolvedBy: null,
    });
    expect((await reply(owner, thread.id, 'Now yes')).statusCode).toBe(201);

    // Removing the thread removes its replies, audited with their number.
    expect(
      (await call('DELETE', `${base}/${thread.id}`, owner.headers)).statusCode,
    ).toBe(204);
    expect(await list('')).toEqual([other.id]);
    expect(
      (await auditOf('comment.removed')).find((e) => e.targetId === thread.id)
        ?.details,
    ).toMatchObject({ replies: 3 });
    for (const action of ['comment.resolved', 'comment.reopened']) {
      expect((await auditOf(action)).length).toBeGreaterThan(0);
    }
  });

  it('tells those mentioned who may read the item, and its watchers; the author watches from their first comment', async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const colleague = await person(['viewer'], 'Cleo');
    const item = await createTestItem(app, owner.headers, { title: 'Budget' });
    await watch(owner, item.id);

    // The viewer mentions the colleague (by address), the outsider (who can't read the item) and nobody real.
    const mentioning = await comment(
      viewer,
      item.id,
      `@${colleague.email.toUpperCase()}, @${outsider.email} and @nobody@example.com: please check.`,
    );
    expect(mentioning.mentions).toEqual([colleague.key]);
    // Named by the address too (lower-cased); the outsider's and the unknown one's get none.
    expect(mentioning.mentionNames).toEqual({
      [colleague.key]: 'Cleo',
      [colleague.email.toLowerCase()]: 'Cleo',
    });

    expect(await notified(colleague, 'comment.mentioned')).toEqual([
      expect.objectContaining({
        title: 'Vera mentioned you',
        body: expect.stringContaining('"Budget"'),
        link: `/test-items/${item.id}`,
        data: expect.objectContaining({
          subject: 'TestItem',
          recordId: item.id,
          commentId: mentioning.id,
        }),
      }),
    ]);
    expect(await notified(outsider, 'comment.mentioned')).toEqual([]);
    // Mentioned, not told twice; the colleague doesn't watch the item.
    expect(await notified(colleague, 'comment.added')).toEqual([]);

    // The owner watches their item (its creator): told of the comment; the author isn't.
    expect(await notified(owner, 'comment.added')).toEqual([
      expect.objectContaining({ link: `/test-items/${item.id}` }),
    ]);
    expect(await notified(viewer, 'comment.added')).toEqual([]);

    // The author now watches the item: the owner's answer reaches them, not the owner.
    const watching = await call('GET', '/v1/subscriptions', viewer.headers);
    expect(watching.json<{ items: unknown[] }>().items).toEqual([
      expect.objectContaining({ subject: 'TestItem', recordId: item.id }),
    ]);
    await comment(owner, item.id, 'Thanks!');
    expect(await notified(viewer, 'comment.added')).toHaveLength(1);

    // Having stopped watching, a later comment of theirs doesn't make them watch again.
    expect(
      (
        await call(
          'DELETE',
          `/v1/subscriptions/TestItem/${item.id}`,
          viewer.headers,
        )
      ).statusCode,
    ).toBe(204);
    await comment(viewer, item.id, 'Again');
    expect(
      (await call('GET', '/v1/subscriptions', viewer.headers)).json<{
        items: unknown[];
      }>().items,
    ).toEqual([]);

    // Mentioned by `@user:<id>` in an edit: told then, once per new mention.
    const plain = await comment(owner, item.id, 'Later');
    const base = `/v1/test-items/${item.id}/comments/${plain.id}`;
    for (const body of [
      `Later, @user:${colleague.id}`,
      `Later still, @user:${colleague.id}`,
    ]) {
      expect(
        (await call('PATCH', base, owner.headers, { body })).statusCode,
      ).toBe(200);
    }
    expect(await notified(colleague, 'comment.mentioned')).toHaveLength(2);
  });

  it("names the authors and the people mentioned: a member who left keeps their name, another tenant's people have none; an address with dots mentions", async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const colleague = await person(['viewer'], 'Cleo');
    const dotted = await member(app, tenantId, ['viewer'], {
      name: 'Maya Patel',
      email: `maya.patel.${randomUUID().slice(0, 6)}@demo.example.com`,
    });
    const item = await createTestItem(app, owner.headers);
    const stranger = await member(
      app,
      (await recordsTenant(app)).tenantId,
      ['viewer'],
      { name: 'Stranger' },
    );

    const both = await comment(
      owner,
      item.id,
      `@user:${viewer.id} and @${colleague.email}, with @user:${stranger.id} and @${dotted.email}`,
    );
    // Another tenant's person is nobody here: not mentioned, not named.
    expect(both.mentions).toEqual([
      viewer.key,
      colleague.key,
      `user:${dotted.id}`,
    ]);
    expect(both.mentionNames).toEqual({
      [viewer.key]: 'Vera',
      [colleague.key]: 'Cleo',
      [`user:${dotted.id}`]: 'Maya Patel',
      [colleague.email.toLowerCase()]: 'Cleo',
      [dotted.email.toLowerCase()]: 'Maya Patel',
    });
    // Mentioned by key: no address entry, whatever the text says.
    const byKey = await comment(
      viewer,
      item.id,
      `@user:${colleague.id} and ${colleague.email}`,
    );
    expect(byKey.mentionNames).toEqual({ [colleague.key]: 'Cleo' });

    // The list names them for every reader; `fields=` picks them.
    const picked = await call(
      'GET',
      `/v1/test-items/${item.id}/comments?fields=mentions,mentionNames`,
      colleague.headers,
    );
    expect(picked.json<{ items: unknown[] }>().items[1]).toEqual({
      id: byKey.id,
      mentions: [colleague.key],
      mentionNames: { [colleague.key]: 'Cleo' },
    });

    // An edit answers with the names of what it now mentions.
    const edited = await call(
      'PATCH',
      `/v1/test-items/${item.id}/comments/${both.id}`,
      owner.headers,
      { body: `Only @user:${viewer.id}` },
    );
    expect(edited.json<Comment>().mentionNames).toEqual({
      [viewer.key]: 'Vera',
    });

    // A member who left the tenant keeps their name; a key of someone the tenant never had has none.
    await inTenant(() =>
      db()
        .update(comments)
        .set({ mentions: [colleague.key, `user:${stranger.id}`] })
        .where(eq(comments.id, byKey.id)),
    );
    const later = await call(
      'GET',
      `/v1/test-items/${item.id}/comments`,
      owner.headers,
    );
    expect(
      later.json<{ items: Comment[] }>().items.map((c) => c.mentionNames),
    ).toEqual([
      { [viewer.key]: 'Vera' },
      { [colleague.key]: 'Cleo', [`user:${stranger.id}`]: null },
    ]);
  });

  it("tells the record's open pages over realtime (those who may read it, never the text); a purged record's comments go", async () => {
    const owner = await person(['editor'], 'Owen');
    const viewer = await person(['viewer'], 'Vera');
    const outsider = await person(['editor'], 'Otto');
    const item = await createTestItem(app, owner.headers);
    const base = `/v1/test-items/${item.id}/comments`;
    // The outsider watches the item but may not read it: nothing reaches them.
    await watch(owner, item.id);
    await inTenant(() =>
      db().insert(recordSubscriptions).values({
        subject: 'TestItem',
        recordId: item.id,
        subscriber: outsider.key,
      }),
    );
    const push = vi.spyOn(app.get(Realtime), 'toPrincipals');
    // This item's comment events only: pushes of earlier tests' events may
    // still arrive (the outbox delivers after the commit), more so under load.
    const commented = () =>
      push.mock.calls.filter(
        ([, event, data]) =>
          event.name === 'record.commented' &&
          (data as { recordId?: string }).recordId === item.id,
      );
    const added = await comment(viewer, item.id, 'A thought');
    await vi.waitFor(() => expect(commented()).toHaveLength(1));
    await call('PATCH', `${base}/${added.id}`, viewer.headers, {
      body: 'A better thought',
    });
    await vi.waitFor(() => expect(commented()).toHaveLength(2));
    await call('DELETE', `${base}/${added.id}`, viewer.headers);
    await vi.waitFor(() => expect(commented()).toHaveLength(3));
    expect(commented().map(([, event, data]) => [event.name, data])).toEqual(
      ['added', 'edited', 'removed'].map((action) => [
        'record.commented',
        {
          subject: 'TestItem',
          recordId: item.id,
          commentId: added.id,
          action,
        },
      ]),
    );
    // The owner watches their item, the viewer wrote: both hear it; the outsider never does.
    const audience = [...(commented()[0]![0] as Iterable<{ id: string }>)].map(
      (p) => p.id,
    );
    expect(audience.sort()).toEqual([owner.id, viewer.id].sort());
    expect(audience).not.toContain(outsider.id);
    push.mockRestore();

    // Gone for good with the record (the recycle bin's purge): its comments go too.
    await comment(owner, item.id, 'Soon gone');
    await call('DELETE', `/v1/test-items/${item.id}`, owner.headers);
    await inTenant(() =>
      db()
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(inArray(testItems.id, [item.id])),
    );
    await app.get(RecycleBinPurgeJob).run();
    const left = await inTenant(() =>
      db()
        .select({ id: comments.id })
        .from(comments)
        .where(and(eq(comments.recordId, item.id))),
    );
    expect(left).toEqual([]);
  });

  // modules/merge calls the hook; its test of every hook is its own.
  it("moves a merged duplicate's comments to the survivor (RecordHooks.merged)", async () => {
    const writer = await person(['editor'], 'Merle');
    const survivor = await createTestItem(app, writer.headers);
    const duplicate = await createTestItem(app, writer.headers);
    await comment(writer, duplicate.id, 'Same customer');
    await mergeTestItems(app, tenantId, duplicate.id, survivor.id);
    const listed = await call(
      'GET',
      `/v1/test-items/${survivor.id}/comments`,
      writer.headers,
    );
    expect(listed.json().items.map((c: { body: string }) => c.body)).toEqual([
      'Same customer',
    ]);
  });
});
