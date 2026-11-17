import { inject } from 'vitest';
import { createDatabase } from './postgres.js';

// Each e2e file runs on a copy of the run's migrated template
// (global-setup.ts), set as DATABASE_URL before the module under test reads
// it: nothing to migrate at start, and no file sees another's rows.
const database = await createDatabase(
  inject('postgresUrl'),
  inject('databasePrefix'),
  inject('templateDatabase'),
);
Object.assign(process.env, {
  DATABASE_URL: database.url,
  MIGRATE_ON_START: 'off',
});
afterAll(() => database.drop());
