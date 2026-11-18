import { AttachmentsPersonalData } from './attachments.personal-data.js';
import { attachments } from './attachments.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-attachments-${process.pid}-${Date.now()}`,
  });
});

/** The `attachments` section (attachments.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('attachments', [AttachmentsPersonalData], {
  seed: async (c) => {
    const base = {
      subject: 'TestItem',
      recordId: uuid(),
      size: 1,
      contentType: 'text/plain',
    };
    await c.inTenant(() =>
      c.db.insert(attachments).values([
        { ...base, key: 'k/a', name: 'a.txt', uploadedBy: c.a.key },
        { ...base, key: 'k/b', name: 'b.txt', uploadedBy: c.b.key },
      ]),
    );
  },
  exported: async (c) => {
    const rows = await c.exported(c.a.id, 'attachments');
    expect(rows.map((r) => r.name)).toEqual(['a.txt']);
    // The row, never the file's key.
    expect(rows[0]).not.toHaveProperty('key');
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(attachments));
    expect(
      rows
        .map((r) => [r.name, r.uploadedBy])
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual([
      ['a.txt', 'anonymized'],
      ['b.txt', c.b.key],
    ]);
  },
});
