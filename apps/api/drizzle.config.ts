import { defineConfig } from 'drizzle-kit';

/**
 * Migrations come from the tables, never by hand: change a `*.tables.ts`,
 * run `pnpm db:generate`, review and commit what it writes to drizzle/.
 * The glob finds every module's tables where the module keeps them: there is
 * no central schema file to edit.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/**/*.tables.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://app:app@127.0.0.1:5432/app',
  },
});
