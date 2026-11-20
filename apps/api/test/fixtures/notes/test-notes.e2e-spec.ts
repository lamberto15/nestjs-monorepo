import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../boot.js';
import {
  createTestItem,
  type Member,
  recordsTenant,
  testItemModules,
} from '../../records.js';
import type { Database } from '../../../src/core/database/database.js';
import { Tenancy } from '../../../src/core/tenancy/tenancy.service.js';
import { testItemsModule } from '../test-items/test-items.module.js';
import {
  TestNotesModule,
  TestNotesWithoutRouteModule,
} from './test-notes.module.js';
import { testNotes } from './test-notes.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, { SCHEDULER: 'off', IDEMPOTENCY: 'optional' });
});

// A child read through its parent (readThrough): the parent's related
// panel lists it at the parent's route, for whoever may read the parent.

describe('children read through their parent (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let editor: Member;
  let viewer: Member;
  let other: Member;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      testItemsModule(),
      TestNotesModule,
    );
    ({ tenantId, editor, viewer, other } = await recordsTenant(app));
  });
  afterAll(async () => {
    await app?.close();
  });

  const get = (url: string, member: Member) =>
    app.inject({ method: 'GET', url, headers: member.headers });
  const note = (itemId: string, body: string) =>
    app.get(Tenancy).run(tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .insert(testNotes)
        .values({ tenantId, ownerId: `user:${editor.id}`, itemId, body }),
    );

  it("names the parent's route and the child's columns to whoever may read the parent, without the child's permission", async () => {
    const described = await get('/v1/lists/TestItem', viewer);
    expect(described.statusCode).toBe(200);
    const notes = described
      .json<{
        related: {
          subject: string;
          path: string;
          through?: { fields: { name: string }[]; select: string[] };
        }[];
      }>()
      .related.find((r) => r.subject === 'TestNote');
    expect(notes).toMatchObject({
      path: 'test-items/{id}/test-notes',
      field: 'itemId',
      title: 'body',
    });
    expect(notes?.through?.select).toContain('body');
    expect(notes?.through?.fields.map((f) => f.name)).toContain('body');
    // Their own list is not theirs to read.
    expect((await get('/v1/lists/TestNote', viewer)).statusCode).toBe(403);
  });

  it('pages through them at that route, newest first, and hides a parent the caller may not read', async () => {
    const item = await createTestItem(app, editor.headers, { title: 'Logged' });
    for (const body of ['First', 'Second', 'Third']) await note(item.id, body);
    const first = (
      await get(`/v1/test-items/${item.id}/test-notes?limit=2`, viewer)
    ).json<{ items: { body: string }[]; nextCursor: string | null }>();
    expect(first.items.map((n) => n.body)).toEqual(['Third', 'Second']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (
      await get(
        `/v1/test-items/${item.id}/test-notes?limit=2&cursor=${first.nextCursor}`,
        viewer,
      )
    ).json<{ items: { body: string }[]; nextCursor: string | null }>();
    expect(second).toEqual({
      items: [expect.objectContaining({ body: 'First' })],
      nextCursor: null,
    });
    // Another editor reads only their own items: neither the item nor its notes.
    expect(
      (await get(`/v1/test-items/${item.id}/test-notes`, other)).statusCode,
    ).toBe(404);
  });

  it('refuses to start when the route they are read at is missing', async () => {
    await expect(
      bootModules(
        ...testItemModules(),
        testItemsModule(),
        TestNotesWithoutRouteModule,
      ),
    ).rejects.toThrow(
      'TestNote is read through itemId (readThrough): no GET /v1/test-items/{id}/test-notes route lists them.',
    );
  });
});
