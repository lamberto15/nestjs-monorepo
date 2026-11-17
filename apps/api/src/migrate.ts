import { databaseConfig } from './core/database/database.config.js';
import { migrateAll } from './core/database/migrations.js';

/**
 * Applies the pending migrations (drizzle/) as DATABASE_OWNER_URL, then makes
 * or checks the app's roles (DATABASE_URL's, DATABASE_MAINTENANCE_URL's) and
 * the tenant wall, once per deploy, before the new release starts, with
 * MIGRATE_ON_START off in production:
 *
 *   DATABASE_OWNER_URL=postgres://… DATABASE_URL=postgres://… node dist/migrate
 *
 * Under an advisory lock (migrations.ts, roles.ts): a second run waits, then
 * finds nothing to do. A failure throws, so the process exits with an error.
 */
const config = databaseConfig();
await migrateAll(
  {
    ownerUrl: config.ownerUrl,
    appUrl: config.url,
    maintenanceUrl: config.maintenanceUrl,
  },
  { log: (line) => console.log(line) },
);
console.log('Migrations applied.');
