import { RevisionsPersonalData } from './revisions.personal-data.js';
import { revisions } from './revisions.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-revisions-${process.pid}-${Date.now()}`,
  });
});

/** The `revisions` section (revisions.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('revisions', [RevisionsPersonalData], {
  seed: async (c) => {
    const base = { subject: 'TestItem', recordId: uuid(), snapshot: {} };
    await c.inTenant(() =>
      c.db.insert(revisions).values([
        { ...base, number: 1, changedBy: c.a.key },
        { ...base, number: 2, changedBy: c.b.key },
      ]),
    );
  },
  // Revisions are the records' history: nothing in the export.,
  exported: async (c) => {
    expect(await c.exported(c.a.id, 'revisions')).toEqual([]);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(revisions));
    expect(
      rows
        .map((r) => r.changedBy)
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual(
      ['anonymized', c.b.key].sort((x, y) =>
        String(x).localeCompare(String(y)),
      ),
    );
  },
});
