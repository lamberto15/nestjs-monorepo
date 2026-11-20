import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * The development services' host ports, as `pnpm run setup --dev-ports <n>`
 * wrote them to the repository root's `.env` for compose.dev.yaml
 * (POSTGRES_PORT, REDIS_PORT): a second project's tests use its own
 * services, not the first one's (docs/development.md, "Two projects on one
 * machine"). The defaults without that file: 5432 and 6379.
 */
export function devServices(
  root = join(import.meta.dirname, '..', '..', '..'),
) {
  const file = join(root, '.env');
  const env = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const postgres = env.POSTGRES_PORT ?? '5432';
  const redis = env.REDIS_PORT ?? '6379';
  return {
    /** compose.dev.yaml's superuser: TEST_DATABASE_URL's default. */
    postgresUrl: `postgres://app:app@127.0.0.1:${postgres}/app`,
    /** REDIS_URL's default for the tests. */
    redisUrl: `redis://127.0.0.1:${redis}`,
  };
}
