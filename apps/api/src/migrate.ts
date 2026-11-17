import { databaseConfig } from './core/database/database.config.js';
import { migrateDatabase } from './core/database/migrations.js';

/**
 * Applies the pending migrations (drizzle/) to DATABASE_URL's database, once
 * per deploy, before the new release starts, with MIGRATE_ON_START off in
 * production:
 *
 *   DATABASE_URL=postgres://… node dist/migrate
 *
 * Under an advisory lock (migrations.ts): a second run waits, then finds
 * nothing to do. A failure throws, so the process exits with an error.
 */
await migrateDatabase(databaseConfig().url);
console.log('Migrations applied.');
