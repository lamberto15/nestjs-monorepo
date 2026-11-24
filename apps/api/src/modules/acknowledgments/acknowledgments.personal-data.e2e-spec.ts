import { AcknowledgmentsPersonalData } from './acknowledgments.personal-data.js';
import { AcknowledgmentsRepository } from './acknowledgments.repository.js';
import { recordAcknowledgments } from './acknowledgments.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-acknowledgments-${process.pid}-${Date.now()}`,
  });
});

/** The `acknowledgments` section (acknowledgments.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection(
  'acknowledgments',
  [AcknowledgmentsPersonalData, AcknowledgmentsRepository],
  {
    seed: async (c) => {
      const base = {
        subject: 'TestItem',
        recordId: uuid(),
        version: 1,
        requestedBy: c.b.key,
      };
      await c.inTenant(() =>
        c.db.insert(recordAcknowledgments).values([
          { ...base, recipient: c.a.key },
          { ...base, recipient: c.b.key },
        ]),
      );
    },
    exported: async (c) => {
      expect(await c.exported(c.a.id, 'acknowledgments')).toHaveLength(1);
    },
    erased: async (c) => {
      const rows = await c.inTenant(() =>
        c.db.select().from(recordAcknowledgments),
      );
      expect(rows.map((r) => r.recipient)).toEqual([c.b.key]);
    },
  },
);
