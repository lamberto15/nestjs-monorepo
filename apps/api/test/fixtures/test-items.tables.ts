import { fileURLToPath } from 'node:url';
import { type AnyPgColumn, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../src/core/database/columns.js';

/**
 * A table for the tests only: its migrations are in test/fixtures/drizzle
 * (`pnpm exec drizzle-kit generate --config test/fixtures/drizzle.config.ts`),
 * applied to the tests' template database only (global-setup.ts).
 */
export const testItems = pgTable('test_items', {
  id: uuidPk(),
  name: text('name').notNull().unique(),
  parentId: uuid('parent_id').references((): AnyPgColumn => testItems.id),
  ...timestamps(),
});

/** Where the fixtures' migrations are, recorded apart from the app's. */
export const FIXTURE_MIGRATIONS = {
  migrationsFolder: fileURLToPath(new URL('./drizzle', import.meta.url)),
  migrationsTable: '__drizzle_fixture_migrations',
};
