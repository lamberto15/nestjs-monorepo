import { ReportsPersonalData } from './reports.personal-data.js';
import { reportSchedules } from './reports.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-reports-${process.pid}-${Date.now()}`,
  });
});

/** The `reports` section (reports.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('reports', [ReportsPersonalData], {
  seed: async (c) => {
    const base = {
      exporter: 'test-items',
      format: 'csv',
      timezone: 'UTC',
      schedule: { every: 'daily' as const, hour: 8 },
      recipients: [],
      nextRunAt: new Date(),
    };
    await c.inTenant(() =>
      c.db.insert(reportSchedules).values([
        { ...base, owner: c.a.key, name: 'A report' },
        { ...base, owner: c.b.key, name: 'B report' },
      ]),
    );
  },
  exported: async (c) => {
    expect((await c.exported(c.a.id, 'reports')).map((r) => r.name)).toEqual([
      'A report',
    ]);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(reportSchedules));
    expect(rows.map((r) => r.owner)).toEqual([c.b.key]);
  },
});
