import { inject } from 'vitest';
import { createDatabase, databaseUrl } from './postgres.js';

// Each e2e file runs on a copy of the run's migrated template
// (global-setup.ts), owned by the run's owner role, set as the database
// variables before the module under test reads them: nothing to migrate at
// start, no file sees another's rows, and every app connects as the app's
// role, which row-level security binds, as in a deployment.
const database = await createDatabase(
  inject('postgresUrl'),
  inject('databasePrefix'),
  inject('templateDatabase'),
  inject('ownerRole'),
);
Object.assign(process.env, {
  DATABASE_URL: databaseUrl(inject('appUrl'), database.name),
  DATABASE_OWNER_URL: databaseUrl(inject('ownerUrl'), database.name),
  DATABASE_MAINTENANCE_URL: databaseUrl(
    inject('maintenanceUrl'),
    database.name,
  ),
  MIGRATE_ON_START: 'off',
});
afterAll(() => database.drop());
