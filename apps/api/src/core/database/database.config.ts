import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  integer,
  optional,
  secret,
  withDefault,
} from '../config/env.helpers.js';
import { readEnv } from '../config/env.js';

export const schema = z.object({
  DATABASE_URL: secret(z.url({ protocol: /^postgres(ql)?$/ }))
    .describe('PostgreSQL 18 or later.')
    .meta({ example: 'postgres://app:app@127.0.0.1:5432/app' }),
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
  return {
    url: env.DATABASE_URL,
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
