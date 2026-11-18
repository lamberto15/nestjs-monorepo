import { ViewsPersonalData } from './views.personal-data.js';
import { savedViews } from './views.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-views-${process.pid}-${Date.now()}`,
  });
});

/** The `views` section (views.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('views', [ViewsPersonalData], {
  seed: async (c) => {
    const base = { subject: 'TestItem', scope: 'tenant' };
    const values = (owner: string, label: string, visibility: string) => ({
      ...base,
      owner,
      name: `${label}-views`,
      visibility: visibility as 'private',
    });
    await c.inTenant(() =>
      c.db
        .insert(savedViews)
        .values([
          values(c.a.key, 'a-private', 'private'),
          values(c.a.key, 'a-shared', 'tenant'),
          values(c.b.key, 'b-private', 'private'),
        ]),
    );
  },
  exported: async (c) => {
    expect(await c.exported(c.a.id, 'views')).toHaveLength(2);
    expect(await c.exported(c.b.id, 'views')).toHaveLength(1);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(savedViews));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.owner]));
    // A's private one is gone, the shared one is ownerless, B's is theirs.
    expect(byName).toEqual({
      [`a-shared-views`]: 'anonymous',
      [`b-private-views`]: c.b.key,
    });
  },
});
