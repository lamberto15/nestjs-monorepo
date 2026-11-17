import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import {
  MIGRATIONS_FOLDER,
  migrateAll,
} from '../src/core/database/migrations.js';
import { FIXTURE_MIGRATIONS } from './fixtures/test-items.tables.js';
import { asRole, databaseUrl, onServer } from './postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** A PostgreSQL server the tests may create databases on, as a role that may (the superuser of compose.dev.yaml). */
    postgresUrl: string;
    /** The migrated database each test file gets a copy of. */
    templateDatabase: string;
    /** This run's prefix for its databases and roles: `e2e_<run>`. */
    databasePrefix: string;
    /**
     * The run's roles on the server (a URL's database is swapped with
     * databaseUrl()), as a deployment has them: the owner (owns the tables,
     * runs the migrations; CREATEROLE, no superuser, as a managed PostgreSQL
     * gives), the app's (what every app under test connects as: bound by
     * row-level security), the maintenance role (BYPASSRLS).
     */
    ownerRole: string;
    ownerUrl: string;
    appUrl: string;
    maintenanceUrl: string;
  }
}

/**
 * One template database per run, migrated once as the run's owner role (the
 * app's migrations, then the test fixtures' in a migrations table of their
 * own), its roles and tenant wall made as `node dist/migrate` makes them, on
 * the development server (pnpm services:up) or TEST_DATABASE_URL's, a
 * superuser. Each test file gets a copy (setup-env.ts). The teardown drops
 * the template, every copy of this run a test file left, and the run's
 * roles, so the server is left as it was found.
 */
export default async function setup(project: TestProject) {
  const serverUrl =
    process.env.TEST_DATABASE_URL ?? 'postgres://app:app@127.0.0.1:5432/app';
  const prefix = `e2e_${randomUUID().slice(0, 8)}`;
  const template = `${prefix}_template`;
  const [owner, app, maintenance] = ['owner', 'app', 'maint'].map(
    (role) => `${prefix}_${role}`,
  ) as [string, string, string];
  const secret = () => randomBytes(12).toString('hex');
  const ownerSecret = secret();
  const maintenanceSecret = secret();
  const urls = {
    ownerUrl: asRole(serverUrl, owner, ownerSecret),
    appUrl: asRole(serverUrl, app, secret()),
    maintenanceUrl: asRole(serverUrl, maintenance, maintenanceSecret),
  };
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
      for (const role of [app, maintenance, owner]) {
        await client.query(`drop role if exists "${role}"`);
      }
    } finally {
      await client.end();
    }
  };
  try {
    await onServer(
      serverUrl,
      `create role "${owner}" login createrole nosuperuser nocreatedb nobypassrls password '${ownerSecret}'`,
    );
    // Made by the server's superuser, as on a managed PostgreSQL whose admin
    // may not create a BYPASSRLS role: the bootstrap checks and grants it.
    await onServer(
      serverUrl,
      `create role "${maintenance}" login bypassrls nosuperuser nocreatedb nocreaterole password '${maintenanceSecret}'`,
    );
    await onServer(serverUrl, `create database "${template}" owner "${owner}"`);
    await migrateAll(
      {
        ownerUrl: databaseUrl(urls.ownerUrl, template),
        appUrl: databaseUrl(urls.appUrl, template),
        maintenanceUrl: databaseUrl(urls.maintenanceUrl, template),
      },
      {
        migrations: [
          { migrationsFolder: MIGRATIONS_FOLDER },
          FIXTURE_MIGRATIONS,
        ],
      },
    );
  } catch (error) {
    await teardown();
    throw error;
  }
  project.provide('postgresUrl', serverUrl);
  project.provide('templateDatabase', template);
  project.provide('databasePrefix', prefix);
  project.provide('ownerRole', owner);
  project.provide('ownerUrl', urls.ownerUrl);
  project.provide('appUrl', urls.appUrl);
  project.provide('maintenanceUrl', urls.maintenanceUrl);
  return teardown;
}
