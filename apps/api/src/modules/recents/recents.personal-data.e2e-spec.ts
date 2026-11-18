import { RecentsPersonalData } from './recents.personal-data.js';
import { recentRecords } from './recents.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-recents-${process.pid}-${Date.now()}`,
  });
});

/** The `recents` section (recents.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('recents', [RecentsPersonalData], {
  seed: async (c) => {
    await c.inTenant(() =>
      c.db.insert(recentRecords).values([
        { owner: c.a.key, subject: 'TestItem', recordId: 'x', label: 'A' },
        { owner: c.b.key, subject: 'TestItem', recordId: 'x', label: 'B' },
      ]),
    );
  },
  exported: async (c) => {
    expect((await c.exported(c.a.id, 'recents')).map((r) => r.label)).toEqual([
      'A',
    ]);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(recentRecords));
    expect(rows.map((r) => r.owner)).toEqual([c.b.key]);
  },
});
