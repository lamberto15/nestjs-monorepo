import { existsSync, readdirSync } from 'node:fs';
import { getDrizzleToken } from '@nestjs/drizzle';
import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { inject } from 'vitest';
import { bootModules } from '../../../test/boot.js';
import { FIXTURE_MIGRATIONS } from '../../../test/fixtures/test-items.tables.js';
import { createDatabase } from '../../../test/postgres.js';
import { DatabaseModule } from './database.module.js';
import type { Database } from './database.js';
import { MIGRATIONS_FOLDER, migrateDatabase } from './migrations.js';

/** Drizzle's bookkeeping table `name`, read with the query builder. */
const migrationsTable = (name: string) =>
  pgSchema('drizzle').table(name, { id: serial('id'), name: text('name') });

/** How many migrations `table` records on the database at `url`, 0 when it doesn't exist. */
async function applied(url: string, table: string) {
  const db = drizzle({ connection: url });
  try {
    const [row] = await db.select({ n: count() }).from(migrationsTable(table));
    return row!.n;
  } catch (error) {
    // undefined_table: nothing was ever migrated with this table.
    if ((error as { cause?: { code?: string } }).cause?.code === '42P01') {
      return 0;
    }
    throw error;
  } finally {
    await db.$client.end();
  }
}

const folders = (folder: string) =>
  existsSync(folder)
    ? readdirSync(folder).filter((name) =>
        existsSync(`${folder}/${name}/migration.sql`),
      ).length
    : 0;

/** A fresh, empty database for one test. */
const empty = () =>
  createDatabase(inject('postgresUrl'), inject('databasePrefix'));

describe('migrations (e2e)', () => {
  it('applies every pending migration once, and again finds nothing to do', async () => {
    const database = await empty();
    try {
      const expected = folders(FIXTURE_MIGRATIONS.migrationsFolder);
      expect(expected).toBeGreaterThan(0);
      await migrateDatabase(database.url, FIXTURE_MIGRATIONS);
      await migrateDatabase(database.url, FIXTURE_MIGRATIONS);
      expect(
        await applied(database.url, FIXTURE_MIGRATIONS.migrationsTable),
      ).toBe(expected);
    } finally {
      await database.drop();
    }
  });

  it('lets instances starting together migrate without a race (advisory lock)', async () => {
    const database = await empty();
    try {
      await Promise.all(
        [1, 2, 3].map(() => migrateDatabase(database.url, FIXTURE_MIGRATIONS)),
      );
      expect(
        await applied(database.url, FIXTURE_MIGRATIONS.migrationsTable),
      ).toBe(folders(FIXTURE_MIGRATIONS.migrationsFolder));
    } finally {
      await database.drop();
    }
  });

  describe('MIGRATE_ON_START', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env.DATABASE_URL = saved.DATABASE_URL;
      process.env.MIGRATE_ON_START = saved.MIGRATE_ON_START;
    });

    async function bootOn(migrateOnStart: string | undefined, url: string) {
      process.env.DATABASE_URL = url;
      if (migrateOnStart === undefined) delete process.env.MIGRATE_ON_START;
      else process.env.MIGRATE_ON_START = migrateOnStart;
      const app = await bootModules(DatabaseModule);
      // The app's pool is on the database it was given.
      app.get<Database>(getDrizzleToken());
      await app.close();
    }

    // drizzle/ appears with the first module's tables: until then, there is
    // nothing for the start to apply.
    const noAppMigrations = folders(MIGRATIONS_FOLDER) === 0;

    it.skipIf(noAppMigrations)(
      'applies drizzle/ at start, by default outside production',
      async () => {
        const database = await empty();
        try {
          await bootOn(undefined, database.url);
          expect(await applied(database.url, '__drizzle_migrations')).toBe(
            folders(MIGRATIONS_FOLDER),
          );
        } finally {
          await database.drop();
        }
      },
    );

    it('applies nothing when off', async () => {
      const database = await empty();
      try {
        await bootOn('off', database.url);
        expect(await applied(database.url, '__drizzle_migrations')).toBe(0);
      } finally {
        await database.drop();
      }
    });

    it.skipIf(noAppMigrations)(
      'node dist/migrate applies drizzle/ to DATABASE_URL',
      async () => {
        const database = await empty();
        try {
          process.env.DATABASE_URL = database.url;
          await import('../../migrate.js');
          expect(await applied(database.url, '__drizzle_migrations')).toBe(
            folders(MIGRATIONS_FOLDER),
          );
        } finally {
          await database.drop();
        }
      },
    );
  });
});
