// The API the browser tests run against (playwright.config.ts, `webServer`):
// the demo seed first, then the built API (`node dist/main`), which serves
// the built web app (core/web, WEB_ROOT) from its own origin, as in production.
//
// The seed (docs/development.md, "Demo data") makes the demo tenant's members
// in the seed roles and prints their generated passwords once. They are kept
// in playwright/.auth/credentials.json (ignored by git) for the sign-in setup
// (test/auth.setup.ts). A database seeded before prints none: the file from
// that run stays, or E2E_CREDENTIALS points at another.
//
// The environment is what `pnpm services:up` (the development services) and
// apps/api/env.example give, each variable overridable from the shell. The
// tests use a database of their own on that server (E2E_DATABASE, created
// and marked as a development one, which the seed needs): the development
// database keeps its data, and its secrets stay sealed with its own keys.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const api = resolve(here, '../../api');
const credentialsFile = resolve(
  here,
  '..',
  process.env.E2E_CREDENTIALS ?? 'playwright/.auth/credentials.json',
);
const webUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3300';
const database = process.env.E2E_DATABASE ?? 'app_browser_tests';
const server = process.env.E2E_POSTGRES ?? 'postgres://app:app@127.0.0.1:5432';

const env = {
  NODE_ENV: 'development',
  // Not 3000 (nor 3100, Gotenberg's): a development stack (pnpm dev) may be running on this machine.
  PORT: '3300',
  DATABASE_URL: `postgres://app_runtime:app_runtime@127.0.0.1:5432/${database}`,
  DATABASE_OWNER_URL: `${server}/${database}`,
  DATABASE_MAINTENANCE_URL: `postgres://app_maintenance:app_maintenance@127.0.0.1:5432/${database}`,
  REDIS_URL: 'redis://127.0.0.1:6379',
  MIGRATE_ON_START: 'on',
  // The built web app, served by the API: one origin, so the __Host-sid
  // cookie works; plain http://localhost accepts Secure cookies.
  WEB_ROOT: resolve(here, '../../web/dist'),
  APP_URL: webUrl,
  WEB_URL: webUrl,
  CORS_ORIGINS: webUrl,
  SESSION_COOKIE_SECURE: 'on',
  AUTH_SIGN_UP: 'on',
  // No outside services: mail to the log, files on disk, no PDFs.
  MAIL_TRANSPORT: 'log',
  STORAGE_DRIVER: 'local',
  PASSWORD_BREACH_CHECK: 'off',
  // SSO connections, devices and phone numbers are encrypted columns, the
  // last two with blind indexes (core/encryption): their keys are required
  // at boot. Fixed, not per run: the tests' database is reused, and what it
  // sealed (app_secrets) must open on the next run. Test keys of a database
  // holding demo data only, never anyone's real keys.
  DATA_ENCRYPTION_KEYS: Buffer.alloc(32, 'browser-tests-data').toString('base64'),
  BLIND_INDEX_KEYS: Buffer.alloc(32, 'browser-tests-index').toString('base64'),
  // The suite signs in a few times per account on a database that may be reused.
  RATE_LIMIT_MULTIPLIER: '20',
  LOG_LEVEL: 'error',
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ),
};

/**
 * The account on one line of the seed's report (report() in
 * apps/api/src/demo/run-demo-seed.ts), as a list of one; none for any other
 * line. An account's line is
 *
 *     "  <email>  <password>  <name> (<roles>)"
 *
 * Read with string methods: one regex for the whole line backtracks in
 * quadratic time on a long line that isn't one (SonarCloud S8786).
 */
function account(line) {
  const open = line.lastIndexOf(' (');
  if (!line.startsWith(' ') || !line.endsWith(')') || open === -1) return [];
  const [email, password, ...name] = line.slice(0, open).trim().split(/ +/);
  const roles = line.slice(open + 2, -1);
  if (!email.includes('@') || !password || name.length === 0) return [];
  if (!roles || roles.includes(')')) return [];
  return [{ email, password, roles: roles.split(', ') }];
}

/**
 * The tests' database, created on the server when it is missing and marked
 * as a development one (tools/dev/10-dev-database.sql's setting). With the
 * API's own driver (pg), resolved from apps/api.
 */
async function prepareDatabase() {
  const { Client } = createRequire(resolve(api, 'package.json'))('pg');
  const client = new Client({ connectionString: `${server}/postgres` });
  await client.connect();
  try {
    const found = await client.query(
      'select 1 from pg_database where datname = $1',
      [database],
    );
    const name = client.escapeIdentifier(database);
    if (found.rowCount === 0) await client.query(`create database ${name}`);
    await client.query(`alter database ${name} set app.dev_database = 'on'`);
  } finally {
    await client.end();
  }
}

function seed() {
  const result = spawnSync(process.execPath, ['dist/demo/seed-demo.js'], {
    cwd: api,
    env,
    encoding: 'utf8',
  });
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  const accounts = result.stdout.split('\n').flatMap(account);
  if (accounts.length === 0) {
    console.log(
      `The demo data was seeded before: keeping ${credentialsFile} (or set E2E_CREDENTIALS).`,
    );
    return;
  }
  mkdirSync(dirname(credentialsFile), { recursive: true });
  writeFileSync(credentialsFile, JSON.stringify(accounts, null, 2), {
    mode: 0o600,
  });
  console.log(`Demo data seeded: ${accounts.length} accounts.`);
}

await prepareDatabase();
seed();
const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: api,
  env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
