import { existsSync, readdirSync } from 'node:fs';
import { getDrizzleToken } from '@nestjs/drizzle';
import { count } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSchema, serial, text } from 'drizzle-orm/pg-core';
import { inject } from 'vitest';
import { bootModules } from '../../../test/boot.js';
import { FIXTURE_MIGRATIONS } from '../../../test/fixtures/test-items.tables.js';
import { createDatabase, databaseUrl } from '../../../test/postgres.js';
import { DatabaseModule } from './database.module.js';
import type { Database } from './database.js';
import {
  MIGRATIONS_FOLDER,
  migrateAll,
  migrateDatabase,
} from './migrations.js';

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

/** A fresh, empty database for one test, owned by the run's owner role, and its URL as each role. */
async function empty() {
  const database = await createDatabase(
    inject('postgresUrl'),
    inject('databasePrefix'),
    undefined,
    inject('ownerRole'),
  );
  return {
    ...database,
    ownerUrl: databaseUrl(inject('ownerUrl'), database.name),
    appUrl: databaseUrl(inject('appUrl'), database.name),
    maintenanceUrl: databaseUrl(inject('maintenanceUrl'), database.name),
  };
}

const ALL = [{ migrationsFolder: MIGRATIONS_FOLDER }, FIXTURE_MIGRATIONS];

describe('migrations (e2e)', () => {
  it('applies every pending migration once, and again finds nothing to do', async () => {
    const database = await empty();
    try {
      const expected = folders(FIXTURE_MIGRATIONS.migrationsFolder);
      expect(expected).toBeGreaterThan(0);
      // The fixtures' tables refer to the app's (tenants).
      await migrateDatabase(database.ownerUrl);
      await migrateDatabase(database.ownerUrl, FIXTURE_MIGRATIONS);
      await migrateDatabase(database.ownerUrl, FIXTURE_MIGRATIONS);
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
        [1, 2, 3].map(() => migrateAll(database, { migrations: ALL })),
      );
      expect(
        await applied(database.url, FIXTURE_MIGRATIONS.migrationsTable),
      ).toBe(folders(FIXTURE_MIGRATIONS.migrationsFolder));
    } finally {
      await database.drop();
    }
  });

  describe('MIGRATE_ON_START', () => {
    const VARIABLES = [
      'DATABASE_URL',
      'DATABASE_OWNER_URL',
      'DATABASE_MAINTENANCE_URL',
      'MIGRATE_ON_START',
    ];
    const saved = { ...process.env };
    afterEach(() => {
      for (const name of VARIABLES) process.env[name] = saved[name];
    });

    const useDatabase = (database: Awaited<ReturnType<typeof empty>>) =>
      Object.assign(process.env, {
        DATABASE_URL: database.appUrl,
        DATABASE_OWNER_URL: database.ownerUrl,
        DATABASE_MAINTENANCE_URL: database.maintenanceUrl,
      });

    async function bootOn(
      migrateOnStart: string | undefined,
      database: Awaited<ReturnType<typeof empty>>,
    ) {
      useDatabase(database);
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
          await bootOn(undefined, database);
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
        // No table at all, so the app's role checks pass: the start reads none.
        await bootOn('off', database);
        expect(await applied(database.url, '__drizzle_migrations')).toBe(0);
      } finally {
        await database.drop();
      }
    });

    it.skipIf(noAppMigrations)(
      'node dist/migrate applies drizzle/ as DATABASE_OWNER_URL',
      async () => {
        const database = await empty();
        try {
          useDatabase(database);
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
