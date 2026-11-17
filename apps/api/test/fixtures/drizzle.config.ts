import { defineConfig } from 'drizzle-kit';

/** The test fixtures' tables and migrations, apart from the app's (drizzle.config.ts). */
export default defineConfig({
  dialect: 'postgresql',
  schema: './test/fixtures/*.tables.ts',
  out: './test/fixtures/drizzle',
});
