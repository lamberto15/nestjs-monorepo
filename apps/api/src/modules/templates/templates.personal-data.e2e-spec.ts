import { TemplatesRepository } from './templates.repository.js';
import { TemplatesPersonalData } from './templates.personal-data.js';
import { recordTemplates } from './templates.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-templates-${process.pid}-${Date.now()}`,
  });
});

/** The `templates` section (templates.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('templates', [TemplatesPersonalData, TemplatesRepository], {
  seed: async (c) => {
    const base = { subject: 'TestItem', scope: 'tenant' };
    const values = (owner: string, label: string, visibility: string) => ({
      ...base,
      owner,
      name: `${label}-templates`,
      visibility: visibility as 'private',
    });
    await c.inTenant(() =>
      c.db
        .insert(recordTemplates)
        .values([
          values(c.a.key, 'a-private', 'private'),
          values(c.a.key, 'a-shared', 'tenant'),
          values(c.b.key, 'b-private', 'private'),
        ]),
    );
  },
  exported: async (c) => {
    expect(await c.exported(c.a.id, 'templates')).toHaveLength(2);
    expect(await c.exported(c.b.id, 'templates')).toHaveLength(1);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(recordTemplates));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.owner]));
    // A's private one is gone, the shared one is ownerless, B's is theirs.
    expect(byName).toEqual({
      [`a-shared-templates`]: 'anonymous',
      [`b-private-templates`]: c.b.key,
    });
  },
});
