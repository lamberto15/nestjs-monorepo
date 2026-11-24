import { FavoritesPersonalData } from './favorites.personal-data.js';
import { FavoritesRepository } from './favorites.repository.js';
import { favorites } from './favorites.tables.js';
import { personalDataSection } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-favorites-${process.pid}-${Date.now()}`,
  });
});

/** The `favorites` section (favorites.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection('favorites', [FavoritesPersonalData, FavoritesRepository], {
  seed: async (c) => {
    await c.inTenant(() =>
      c.db.insert(favorites).values([
        { owner: c.a.key, kind: 'page', target: '/a', label: 'A', position: 1 },
        { owner: c.b.key, kind: 'page', target: '/b', label: 'B', position: 1 },
      ]),
    );
  },
  exported: async (c) => {
    expect((await c.exported(c.a.id, 'favorites')).map((r) => r.label)).toEqual(
      ['A'],
    );
  },
  erased: async (c) => {
    const rows = await c.inTenant(() => c.db.select().from(favorites));
    expect(rows.map((r) => r.owner)).toEqual([c.b.key]);
  },
});
