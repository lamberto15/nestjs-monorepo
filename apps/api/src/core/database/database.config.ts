import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  integer,
  optional,
  secret,
  withDefault,
} from '../config/env.helpers.js';
import { readEnv } from '../config/env.js';

const postgresUrl = () => z.url({ protocol: /^postgres(ql)?$/ });

/**
 * Outside production, the roles compose.dev.yaml's superuser makes at the
 * first start, on DATABASE_URL's server and database (whatever its port:
 * two projects side by side, docs/development.md).
 */
const DEVELOPMENT = {
  owner: 'app:app',
  maintenance: 'app_maintenance:app_maintenance',
};

/** `url` as `role` (`user:password`): the same server and database. */
function asRole(url: string, role: string) {
  const next = new URL(url);
  const [user = '', password = ''] = role.split(':');
  next.username = user;
  next.password = password;
  return next.toString();
}

export const schema = z.object({
  DATABASE_URL: secret(postgresUrl())
    .describe(
      'PostgreSQL 18 or later, as the app\'s role: no superuser, no BYPASSRLS, owning nothing, so row-level security binds it. The migrations make it from this URL (README.md, "Roles").',
    )
    .meta({ example: 'postgres://app_runtime:app_runtime@127.0.0.1:5432/app' }),
  DATABASE_OWNER_URL: secret(
    optional().pipe(postgresUrl().optional()),
  ).describe(
    `The same database as the owner of its tables: runs the migrations (MIGRATE_ON_START, node dist/migrate) and makes the other roles. Give it to the migration only. Unset outside production: DATABASE_URL as ${DEVELOPMENT.owner} (compose.dev.yaml's).`,
  ),
  DATABASE_MAINTENANCE_URL: secret(
    optional().pipe(postgresUrl().optional()),
  ).describe(
    `The maintenance role (BYPASSRLS), for work across every tenant (Tenancy.acrossTenants()); the migrations make it. Give it to workers only; unset, that work is refused. Unset outside production: DATABASE_URL as ${DEVELOPMENT.maintenance}.`,
  ),
  DATABASE_POOL_MAX: integer(10, { min: 1, max: 500 }).describe(
    'Connections this process may hold: replicas × this must stay under max_connections.',
  ),
  DATABASE_POOL_TIMEOUT_MS: integer(5000, { min: 100, max: 60_000 }).describe(
    'How long a query waits for a free connection before it fails: never hang.',
  ),
  DATABASE_STATEMENT_TIMEOUT_MS: integer(30_000, { min: 0 }).describe(
    'PostgreSQL cancels a statement running longer (0: never). Migrations have none.',
  ),
  DATABASE_IDLE_TX_TIMEOUT_MS: integer(60_000, { min: 0 }).describe(
    'PostgreSQL ends a session left idle inside a transaction this long (0: never).',
  ),
  DATABASE_APPLICATION_NAME: withDefault('api').describe(
    'Which process holds a connection, in pg_stat_activity.',
  ),
  MIGRATE_ON_START: optional()
    .pipe(z.enum(['on', 'off']).optional())
    .describe(
      'Apply pending migrations at start: on by default outside production. Production runs `node dist/migrate` once per deploy instead.',
    ),
  NODE_ENV: optional().describe(
    '`production` in a deployment: no migrations at start, JSON logs, strict browser headers, missing texts fall back.',
  ),
});

export const databaseConfig = registerAs('database', () => {
  const env = readEnv(schema);
  const production = env.NODE_ENV === 'production';
  const ownerUrl =
    env.DATABASE_OWNER_URL ??
    (production ? undefined : asRole(env.DATABASE_URL, DEVELOPMENT.owner));
  const maintenanceUrl =
    env.DATABASE_MAINTENANCE_URL ??
    (production
      ? undefined
      : asRole(env.DATABASE_URL, DEVELOPMENT.maintenance));
  // A role's URL on another server or database would make or use its
  // roles there: refused before anything connects.
  for (const [name, url] of [
    ['DATABASE_OWNER_URL', ownerUrl],
    ['DATABASE_MAINTENANCE_URL', maintenanceUrl],
  ] as const) {
    if (url && !sameDatabase(url, env.DATABASE_URL)) {
      throw new Error(
        `${name} must name DATABASE_URL's server and database (only its role differs).`,
      );
    }
  }
  return {
    url: env.DATABASE_URL,
    ownerUrl,
    maintenanceUrl,
    poolMax: env.DATABASE_POOL_MAX,
    poolTimeoutMs: env.DATABASE_POOL_TIMEOUT_MS,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTxTimeoutMs: env.DATABASE_IDLE_TX_TIMEOUT_MS,
    applicationName: env.DATABASE_APPLICATION_NAME,
    migrateOnStart:
      (env.MIGRATE_ON_START ??
        (env.NODE_ENV === 'production' ? 'off' : 'on')) === 'on',
  };
});

function sameDatabase(a: string, b: string) {
  const [x, y] = [new URL(a), new URL(b)];
  return x.host === y.host && x.pathname === y.pathname;
}
