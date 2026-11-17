import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { migrateDatabase } from '../src/core/database/migrations.js';
import { FIXTURE_MIGRATIONS } from './fixtures/test-items.tables.js';
import { databaseUrl, onServer } from './postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** A PostgreSQL server the tests may create databases on. */
    postgresUrl: string;
    /** The migrated database each test file gets a copy of. */
    templateDatabase: string;
    /** This run's prefix for its databases: `e2e_<run>`. */
    databasePrefix: string;
  }
}

/**
 * One template database per run, migrated once (the app's migrations, then
 * the test fixtures' in a migrations table of their own), on the development
 * server (pnpm services:up) or TEST_DATABASE_URL's, a role that may create
 * databases. Each test file gets a copy (setup-env.ts). The teardown drops
 * the template and every copy of this run a test file left, so the server is
 * left as it was found.
 */
export default async function setup(project: TestProject) {
  const serverUrl =
    process.env.TEST_DATABASE_URL ?? 'postgres://app:app@127.0.0.1:5432/app';
  const prefix = `e2e_${randomUUID().slice(0, 8)}`;
  const template = `${prefix}_template`;
  const teardown = async () => {
    const client = new Client({ connectionString: serverUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ datname: string }>(
        'select datname from pg_database where starts_with(datname, $1)',
        [`${prefix}_`],
      );
      for (const { datname } of rows) {
        await client.query(`drop database "${datname}" with (force)`);
      }
    } finally {
      await client.end();
    }
  };
  try {
    await onServer(serverUrl, `create database "${template}"`);
    const url = databaseUrl(serverUrl, template);
    await migrateDatabase(url);
    await migrateDatabase(url, FIXTURE_MIGRATIONS);
  } catch (error) {
    await teardown();
    throw error;
  }
  project.provide('postgresUrl', serverUrl);
  project.provide('templateDatabase', template);
  project.provide('databasePrefix', prefix);
  return teardown;
}
