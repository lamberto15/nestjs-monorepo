import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { MigrationConfig } from 'drizzle-orm/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/**
 * The migrations `pnpm db:generate` writes from the tables: apps/api/drizzle,
 * the same path from src/core/database and dist/core/database.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../../drizzle', import.meta.url),
);

/** The advisory lock key of the migrations (any constant other apps don't use). */
const MIGRATION_LOCK = 7_300_421_019;

/**
 * Applies the pending migrations of `config` (drizzle/ by default) to the
 * database at `url`, each once, recorded in `drizzle.__drizzle_migrations`.
 * Drizzle's migrator takes no lock, so it runs under an advisory lock in one
 * transaction: several instances starting together (or a deploy's
 * `node dist/migrate` and an instance) don't race; the second waits, then
 * finds nothing left to apply. Used by migrate.ts, by MIGRATE_ON_START and
 * by the e2e tests' template database.
 */
export async function migrateDatabase(
  url: string,
  config: MigrationConfig = { migrationsFolder: MIGRATIONS_FOLDER },
) {
  // No module has a table yet, so drizzle-kit wrote no folder.
  if (!existsSync(config.migrationsFolder)) {
    return;
  }
  const db = drizzle({ connection: { connectionString: url, max: 1 } });
  try {
    await db.transaction(async (tx) => {
      // Neither has a query-builder form. A migration may rewrite a large
      // table: no statement timeout for it.
      await tx.execute(sql`set local statement_timeout = 0`);
      await tx.execute(sql`select pg_advisory_xact_lock(${MIGRATION_LOCK})`);
      // In the transaction: the migrator's own transaction becomes a savepoint.
      await migrate(tx as unknown as NodePgDatabase, config);
    });
  } finally {
    await db.$client.end();
  }
}
