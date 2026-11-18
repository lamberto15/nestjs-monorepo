import { AiPersonalData } from './ai.personal-data.js';
import { aiRuns } from './ai.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-ai-${process.pid}-${Date.now()}`,
  });
});

/** The `ai` section (ai.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('ai', [AiPersonalData], {
  seed: async (c) => {
    const base = {
      source: 'test-items',
      subject: 'TestItem',
      recordId: uuid(),
      task: 'summary',
      promptVersion: '1',
      status: 'completed' as const,
    };
    await c.inTenant(() =>
      c.db.insert(aiRuns).values([
        { ...base, requestedBy: c.a.key },
        { ...base, recordId: uuid(), requestedBy: c.b.key },
      ]),
    );
  },
  exported: async (c) => {
    expect(await c.exported(c.a.id, 'ai')).toHaveLength(1);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(aiRuns));
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
