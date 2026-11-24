import { SharesRepository } from './shares.repository.js';
import { SharesPersonalData } from './shares.personal-data.js';
import { recordShares } from './shares.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-shares-${process.pid}-${Date.now()}`,
  });
});

/** The `shares` section (shares.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('shares', [SharesPersonalData, SharesRepository], {
  seed: async (c) => {
    const base = {
      subject: 'TestItem',
      fields: ['title'],
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await c.inTenant(() =>
      c.db.insert(recordShares).values([
        { ...base, recordId: uuid(), tokenHash: uuid(), createdBy: c.a.key },
        { ...base, recordId: uuid(), tokenHash: uuid(), createdBy: c.b.key },
      ]),
    );
  },
  exported: async (c) => {
    const rows = await c.exported(c.a.id, 'shares');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('tokenHash');
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(recordShares));
    const mine = rows.find((r) => r.createdBy === 'anonymous')!;
    expect(mine.revokedAt).not.toBeNull();
    const theirs = rows.find((r) => r.createdBy === c.b.key)!;
    expect(theirs.revokedAt).toBeNull();
  },
});
