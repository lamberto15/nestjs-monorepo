import { CommentsPersonalData } from './comments.personal-data.js';
import { CommentsRepository } from './comments.repository.js';
import { comments } from './comments.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-comments-${process.pid}-${Date.now()}`,
  });
});

/** The `comments` section (comments.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('comments', [CommentsPersonalData, CommentsRepository], {
  seed: async (c) => {
    const base = { subject: 'TestItem', recordId: uuid() };
    await c.inTenant(() =>
      c.db.insert(comments).values([
        { ...base, author: c.a.key, body: 'mine', mentions: [] },
        {
          ...base,
          author: c.b.key,
          body: `hello @${c.a.key}`,
          mentions: [c.a.key],
        },
      ]),
    );
  },
  exported: async (c) => {
    expect((await c.exported(c.a.id, 'comments')).map((r) => r.body)).toEqual([
      'mine',
    ]);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(comments));
    expect(
      rows
        .map((r) => [r.author, r.body, r.mentions])
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual([
      ['anonymous', '[deleted]', []],
      [c.b.key, 'hello @[deleted]', []],
    ]);
  },
});
