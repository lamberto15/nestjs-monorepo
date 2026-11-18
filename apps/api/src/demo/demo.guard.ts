import { sql } from 'drizzle-orm';
import type { Database } from '../core/database/database.js';

/**
 * The demo seed runs only where both halves of a positive check say it
 * may: NODE_ENV says development (or test), and the database itself is
 * marked as a development database. Development and production may run the
 * same image, so NODE_ENV alone proves nothing; the marker is a database-wide
 * setting only a superuser or the database's owner can write (the app's
 * role, an administrator or a SQL injection can't), which the development
 * services set when they create their database
 * (tools/dev/10-dev-database.sql, `pnpm db:mark-dev`). Nothing is refused
 * for looking like production: anything not shown to be development is
 * refused.
 */
export const DEV_DATABASE_SETTING = 'app.dev_database';

const DEMO_NODE_ENVS = ['development', 'test'];

/** Thrown when the seed may not run here: the message says what to do. */
export class DemoSeedRefused extends Error {
  override readonly name = 'DemoSeedRefused';
}

/** Why NODE_ENV forbids the seed, or null when it allows it (NODE_ENV as set: unset is refused). */
export function nodeEnvRefusal(nodeEnv: string | undefined): string | null {
  return nodeEnv && DEMO_NODE_ENVS.includes(nodeEnv)
    ? null
    : `The demo seed runs only with NODE_ENV=development (or test); NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : 'not set'}. In development, set NODE_ENV=development in apps/api/.env.`;
}

/** Why the database's marker forbids the seed, or null when it allows it. */
export function markerRefusal(marked: boolean): string | null {
  return marked
    ? null
    : `This database isn't marked as a development database (${DEV_DATABASE_SETTING} = on), so the demo seed leaves it alone. The development services mark theirs when they create it; for one made before, run \`pnpm db:mark-dev\`.`;
}

/**
 * Whether the current database carries the marker: read from the catalog
 * (pg_db_role_setting, readable by any role), not from the session, so it
 * holds whenever the connection was opened.
 */
export async function isDevDatabase(db: Database): Promise<boolean> {
  // The result is typed over any driver's; node-postgres' is `{ rows }`.
  const { rows } = (await db.execute(sql`
    select exists (
      select 1
      from pg_db_role_setting s
      join pg_database d on d.oid = s.setdatabase
      where d.datname = current_database()
        and s.setrole = 0
        and ${`${DEV_DATABASE_SETTING}=on`} = any (s.setconfig)
    ) as marked
  `)) as unknown as { rows: { marked: boolean }[] };
  return rows[0]?.marked === true;
}
