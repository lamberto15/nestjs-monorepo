import { DocumentsPersonalData } from './documents.personal-data.js';
import { DocumentsRepository } from './documents.repository.js';
import { documents } from './documents.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-documents-${process.pid}-${Date.now()}`,
  });
});

/** The `documents` section (documents.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('documents', [DocumentsPersonalData, DocumentsRepository], {
  seed: async (c) => {
    const base = {
      source: 'test-items',
      template: 't',
      subject: 'TestItem',
      recordId: uuid(),
      locale: 'en',
      timezone: 'UTC',
      status: 'completed' as const,
    };
    await c.inTenant(() =>
      c.db.insert(documents).values([
        { ...base, requestedBy: c.a.key, runToken: uuid() },
        { ...base, requestedBy: c.b.key },
      ]),
    );
  },
  exported: async (c) => {
    const rows = await c.exported(c.a.id, 'documents');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty('runToken');
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(documents));
    expect(
      rows
        .map((r) => r.requestedBy)
        .sort((x, y) => String(x).localeCompare(String(y))),
    ).toEqual(
      ['anonymized', c.b.key].sort((x, y) =>
        String(x).localeCompare(String(y)),
      ),
    );
  },
});
