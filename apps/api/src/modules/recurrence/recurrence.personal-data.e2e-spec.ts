import { RecurrenceRepository } from './recurrence.repository.js';
import { RecurrencePersonalData } from './recurrence.personal-data.js';
import { recordSchedules } from './recurrence.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-record-schedules-${process.pid}-${Date.now()}`,
  });
});

/** The `record-schedules` section (recurrence.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection(
  'record-schedules',
  [RecurrencePersonalData, RecurrenceRepository],
  {
    seed: async (c) => {
      const base = {
        target: 'test-items',
        template: {},
        rrule: 'FREQ=DAILY',
        startDate: '2026-01-01',
        time: '09:00',
        timezone: 'UTC',
      };
      await c.inTenant(() =>
        c.db.insert(recordSchedules).values([
          { ...base, owner: c.a.key, name: 'A schedule' },
          { ...base, owner: c.b.key, name: 'B schedule' },
        ]),
      );
    },
    exported: async (c) => {
      expect(
        (await c.exported(c.a.id, 'record-schedules')).map((r) => r.name),
      ).toEqual(['A schedule']);
    },
    erased: async (c) => {
      const rows = await c.inTenant(() => c.db.select().from(recordSchedules));
      expect(rows.map((r) => r.owner)).toEqual([c.b.key]);
    },
  },
);
