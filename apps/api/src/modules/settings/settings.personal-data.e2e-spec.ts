import { SettingsRepository } from './settings.repository.js';
import { SettingsPersonalData } from './settings.personal-data.js';
import { settingOverrides } from './settings.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-settings-${process.pid}-${Date.now()}`,
  });
});

/** The `settings` section (settings.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('settings', [SettingsPersonalData, SettingsRepository], {
  seed: async (c) => {
    await c.inTenant(() =>
      c.db.insert(settingOverrides).values([
        {
          key: 'ui.theme',
          scope: 'user',
          scopeId: c.a.key,
          value: 'dark',
          updatedBy: c.a.key,
        },
        {
          key: 'ui.theme',
          scope: 'user',
          scopeId: c.b.key,
          value: 'light',
          updatedBy: c.b.key,
        },
      ]),
    );
  },
  exported: async (c) => {
    expect((await c.exported(c.a.id, 'settings')).map((r) => r.value)).toEqual([
      'dark',
    ]);
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(settingOverrides));
    expect(rows.map((r) => r.scopeId)).toEqual([c.b.key]);
  },
});
