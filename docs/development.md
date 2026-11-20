# Development

Setting up, the commands, the database workflow, how the tests are organised and
what runs on a commit. CI runs the whole suite ([ci.md](ci.md)); locally, run what
the change needs. Where things are: [architecture.md](architecture.md).

## Setup

Node 26 or later (`engines`, `.nvmrc`) and pnpm (`packageManager` pins the
version). Docker runs the services.

```bash
pnpm install              # also installs the git hooks (lefthook)
pnpm services:up          # PostgreSQL 18 and Redis (compose.dev.yaml)
pnpm run setup            # writes apps/api/.env with generated keys
pnpm dev                  # the API (http://localhost:3000) and the web app
```

- `pnpm run setup`, not `pnpm setup`: `pnpm setup` is pnpm's own command. The
  script (`tools/setup`) copies `apps/api/env.example` to `apps/api/.env`
  (mode 600) and generates the key lists. It is safe to repeat: an existing
  file keeps its values. `--check` verifies a file, `--rotate` puts a new key in front of
  each key list, `--dry-run` says what it would do, `--web-push <subject>` adds a
  VAPID key pair, `--dev-ports <n>` gives the project
  services of its own (below, "Two projects on one machine").
- Without it, `cp apps/api/env.example apps/api/.env` and fill the lines marked
  `Required.`. **Agents never write `.env` files**: the owner runs the setup or
  copies the template.
- `env.example` is generated from each module's `*.config.ts`: change a schema,
  then run `pnpm env:example`. `pnpm env:check` (CI) fails when the file is stale.
  Both build the API first. Never edit it by hand.
- In development the API migrates at start (`MIGRATE_ON_START`) as the owner role
  and makes its other roles on the first start
  ([`core/database`](../apps/api/src/core/database/README.md), "Roles").
- `APP_ROLE` defaults to `all`, so `pnpm dev` runs the queue workers and
  scheduled jobs in the API process. A separate worker is
  `pnpm --filter api dev:worker`.
- `pnpm dev` builds the packages the apps import (the typed client, the
  components) first.
- `pnpm run setup` sets `WEB_URL=http://localhost:5173`: in development the
  API serves no web app, and the links in mails open the web app's pages.
- `pnpm services:down` stops the services. Every module's variables are in its README.

### Two projects on one machine

Each project made from the template starts the same services on the same
ports (5432, 6379) by default. A second project started beside the first
would connect to the first one's database: its API writes `app_secrets`
under its own `DATA_ENCRYPTION_KEYS`, and the other project's API then
fails ("did not open: unknown key"). Give the second project its own
services, from its folder, before its first `services:up`:

```bash
pnpm run setup --dev-ports 1   # PostgreSQL on 5433, Redis on 6380, Gotenberg 3101, Garage 3901, Nestrix 4319
pnpm services:up               # its own containers and volumes
```

`--dev-ports <n>` moves each port up by `n` (0: the defaults; a third project
takes 2). It writes `.env` at the repository's root, which `docker compose`
reads for `compose.dev.yaml` (`COMPOSE_PROJECT_NAME`, from the folder's name,
so containers and volumes are the project's own, and `POSTGRES_PORT`,
`REDIS_PORT`, `GOTENBERG_PORT`, `GARAGE_PORT`, `NESTRIX_PORT`), and points
`DATABASE_URL` and `REDIS_URL` in `apps/api/.env` at them, the rest of a URL
already set kept. The API's owner and maintenance roles follow `DATABASE_URL`'s
port. Set `GOTENBERG_URL`, `S3_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` to
the moved port when you use those services. A project already on the shared
services moves by running the setup, then `pnpm services:up`: its data starts
empty (its old data is in the other project's database). The two `pnpm dev`s
still share the API's port 3000 and Vite's 5173: run one at a time, or set
`PORT`, `APP_URL` and `WEB_URL` for the second (and `API_URL` for its Vite).

## Commands

Run from the root. Turborepo runs a script in every package that has it
(`turbo.json`).

| Command                                     | Does                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                                  | The API (`nest start --watch -b swc --type-check`) and the web app (Vite). |
| `pnpm build`                                | Builds every package.                                                   |
| `pnpm lint`                                 | oxlint in each package (type-aware); the browser tests also type-check. |
| `pnpm typecheck`                            | Type-checks the packages that have the script.                          |
| `pnpm test`                                 | Unit tests (Vitest) in each package.                                    |
| `pnpm test:e2e`                             | The API's e2e tests: needs the services.                                |
| `pnpm test:e2e:web`                         | The browser tests of the web app ([below](#browser-tests)).             |
| `pnpm test:tools`                           | The tests of `tools/` (Node's test runner).                             |
| `pnpm services:up`, `pnpm services:down`    | The development PostgreSQL and Redis.                                   |
| `pnpm storage:up`                           | Garage, an S3-compatible store, ready for `STORAGE_DRIVER=s3`.          |
| `pnpm traces:up`                            | The Nestrix server, to see where requests spend their time ([below](#traces)). |
| `pnpm run setup`                            | Writes `apps/api/.env`.                                                 |
| `pnpm env:example`, `pnpm env:check`        | Writes or checks `apps/api/env.example`.                                |
| `pnpm feature:add <name> …`                 | Generates a feature ([adding-a-feature.md](adding-a-feature.md)).       |
| `pnpm module:list`, `pnpm module:remove`    | Removes a module ([removing-a-module.md](removing-a-module.md)).        |
| `pnpm ops <command>`                        | The operator CLI ([`cli`](../apps/api/src/cli/README.md)).              |
| `pnpm openapi:dump`                         | Builds the API and writes its OpenAPI document.                         |
| `pnpm client:generate`, `pnpm client:check` | The typed client ([below](#typed-client)).                              |
| `pnpm knip`                                 | Unused files, exports and dependencies (`knip.jsonc`).                  |
| `pnpm raw-sql`                              | The no-raw-SQL check (`tools/ci/raw-sql.mjs`).                          |
| `pnpm db:seed:demo`, `pnpm db:mark-dev`     | The demo seed ([below](#demo-data)).                                    |

The API's development scripts (`dev`, `start:debug`, `dev:worker`, `ops`)
compile with SWC, Nest CLI's `-b swc` builder (`@swc/cli`, `@swc/core`):
measured on this repository, a first build in about 1.3 s instead of 20 s,
and a saved file rebuilt in under 0.1 s instead of about 1 s. `--type-check`
runs `tsc` beside it, so type errors are still reported. `nest build`, the
image's and CI's build, stays on `tsc`. They build into `dist-dev`
(`tsconfig.dev.json`), not `dist`: `pnpm build`, `client:generate`,
`env:example` and the other one-off builds empty `dist`, and a running
`pnpm dev` keeps going.

The API's own scripts (`apps/api/package.json`) run with `pnpm --filter api <script>`:
`db:generate`, `db:migrate`, `db:generate:fixtures`, `test:cov`, `test:watch`,
`format`, `dev:worker`, `start:prod`, `start:worker` and `start:migrate`. The root has
no `db:generate`.

## Database and migrations

Migrations come from the tables, never by hand:

1. Change a `*.tables.ts`.
2. Run `pnpm --filter api db:generate`. It finds every `src/**/*.tables.ts`
   (`drizzle.config.ts`) and writes a migration under `apps/api/drizzle/`.
3. Read the SQL, commit the folder with the tables.

A migration that is merged is never edited, deleted or renamed. A table
declared with `tenantTable()` gets its row-level security policies in the same
migration ([`core/tenancy`](../apps/api/src/core/tenancy/README.md)). Drops,
renames and retypes are reported by the migration lint on a pull request
([ci.md](ci.md)): a release may run on the new schema while old code still serves.

`apps/api/drizzle.config.ts` covers the app. The tables that only the tests
use (`apps/api/test/fixtures/*.tables.ts`) have their own config and folder:
`pnpm --filter api db:generate:fixtures` writes `test/fixtures/drizzle/`, applied
to the tests' template database only, with a migrations table of its own
(`FIXTURE_MIGRATIONS`).

Migrations are applied at start while `MIGRATE_ON_START` is on (the default
outside production), and in a deployment once per deploy with
`node dist/migrate` (`pnpm --filter api start:migrate`), as the owner role. Both
run under an advisory lock.

### Indexes

The tests have a few rows, where a missing index never shows, so two checks
stand in for real sizes:

- `core/database/indexes.e2e-spec.ts` reads the migrated schema (the app's
  tables and the fixtures'): every foreign key has an index leading with its
  columns (a tenant key `(tenant_id, x)` may lead with `x`), and no plain index
  is the leading part of another. Index a foreign key in its table file.
- A query-plan test (`test/query-plans.ts`) seeds a table with many rows of
  other tenants, runs the app's own work through `captured()` and expects
  `fullScans()` to find no statement that reads the whole table. The
  generated feature's lists and the notification retention have one; add one
  for a list or a sweep on a table that grows without bound.

Lead an index with the equality columns (`tenant_id` first on a tenant
table: row-level security adds it to every query), then the sort or range
column. A sweep (`where status = … and at < …`) gets a partial index on its
own predicate. Index creation in a migration runs in its transaction and
locks the table's writes while it builds.

## Tests

- **Unit tests** sit next to the code, `<name>.spec.ts`. They run with
  `pnpm test`, or one package: `pnpm --filter api test`. One file:
  `pnpm --filter api test src/core/http/etag.spec.ts`.
- **e2e tests** are `<name>.e2e-spec.ts`, one set per module, run against a real
  PostgreSQL and Redis (`pnpm services:up` first): `pnpm --filter api test:e2e`,
  or one file as above. Concurrency, locks and row-level security show up
  there and not in a mock. The S3 disk's test (`storage.s3.e2e-spec.ts`)
  runs against Garage (`pnpm storage:up`, which prints the key) when
  `S3_TEST_ENDPOINT` is set, as in CI; it is skipped otherwise.

How an e2e run works (`apps/api/test`, `vitest.config.e2e.ts`):

- `global-setup.ts` connects to `TEST_DATABASE_URL` (default
  `postgres://app:app@127.0.0.1:5432/app`, the development superuser), makes the
  run's owner, app and maintenance roles, and migrates **one template database**
  (the app's migrations, then the fixtures'). Its teardown drops the template, the
  copies and the roles.
- `setup-env.ts` gives **each test file its own copy** of the template as
  `DATABASE_URL` (and the owner and maintenance URLs), with `MIGRATE_ON_START` off.
  The app connects as the role that row-level security binds, as in a deployment.
- `bootModules(...modules)` (`test/boot.ts`) boots the module under test and what it
  imports, never `AppModule`, with the same HTTP setup as `main.ts`. Drive it with
  `app.inject()` and close it with `app.close()`. A module that cannot be tested
  alone is not self-contained. `TEST_LOGS=1` shows the app's errors and warnings.
- A variable a file needs goes into `vi.hoisted()` at the top of the file: the
  environment is read once per file, when `app.module.ts` and the config files
  are imported.

Helpers in `apps/api/test`:

| File                                                               | Gives                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `auth.ts`                                                          | `authModules()`, `createUser`, `signIn`, `signedInUser`, `accessTokenFor`, `apiClient`. |
| `access.ts`                                                        | `accessModules()`, `member`, `tenantWithAdmin`, `seededAdmin`, `roleIds`.               |
| `records.ts`                                                       | `testItemModules()`, `recordsTenant`, `unitWithLead`, `createTestItem`.                 |
| `account.ts`, `sso.ts`, `webhooks.ts`, `software-authenticator.ts` | Browsers, identity providers, webhook receivers and a WebAuthn authenticator.           |
| `postgres.ts`                                                      | Database and role helpers of the global setup.                                          |

**Fixtures** (`apps/api/test/fixtures`) are code that only the tests use. `test-items`
is the hand-written reference record, tested by `test-items.e2e-spec.ts`.
`generated-feature` is what the feature generator writes, with every add-on, never
edited by hand: `generated-feature.spec.ts` fails when it differs from the
generator's output. Both are the shape a new feature takes
([adding-a-feature.md](adding-a-feature.md)).

A change comes with the tests that prove it, in the module's own test file:
[AGENTS.md](../AGENTS.md), rule 10.

## Coverage

`pnpm --filter api test:cov` gates the API's unit tests at the thresholds in
`apps/api/vitest.config.ts`. The web app (`apps/web/vitest.config.ts`) and the
client (`packages/api-client/vitest.config.ts`) have their own, run with their
`test:cov` script. A threshold sits a little under the measured level: raise it
when a change lifts the numbers, never lower it. The e2e config reports coverage
with `--coverage` and has no threshold.

## Static checks

- `pnpm knip` fails on an unused file, export or dependency. `knip.jsonc` lists
  only what knip cannot find, each with its reason.
- `pnpm raw-sql` counts the forms that bypass Drizzle's query builder per file
  against `tools/ci/raw-sql.allow.json`. A new file or a higher count fails.
  Details: [ci.md](ci.md).

## Git hooks

`lefthook.yml` (installed by `pnpm install`; `pnpm exec lefthook install` redoes
it) runs fast checks on the staged files:

- Prettier on TypeScript files under `apps/*/{src,test}` and `packages/*/src`
  (never on Markdown), then oxlint on the API's files, then the raw SQL check.
- `commitlint` on the message: Conventional Commits, `type(scope): subject`
  (`commitlint.config.js`; the header is at most 120 characters).

Skip them once with `git commit --no-verify` or `LEFTHOOK=0 git commit …`. CI runs
the slow checks. To format a Markdown file:
`apps/api/node_modules/.bin/prettier --write <file>`.

## Traces

`pnpm traces:up` starts the Nestrix server (`compose.dev.yaml`, profile
`traces`) with its own database in the development PostgreSQL. Add
`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to `apps/api/.env` and
restart `pnpm dev`: the API and the worker send their traces and runtime
metrics there. Open http://localhost:4318 and sign in with
`nestrix-dev-password` (or `NESTRIX_ADMIN_PASSWORD` when you start it). The
routes view lists each route's calls and their slowest time; a trace shows
where one request went: its queries, outgoing calls and jobs.

Queries that run outside any request, job or traced method (the migrations
at start, the workflow engine's polling) get no trace: Nestrix drops them.
`docker compose -f compose.dev.yaml --profile traces stop nestrix` stops it;
without the variable the app sends nothing.

## Demo data

`pnpm db:seed:demo` builds the API and fills a development database with a demo
tenant, three organizational units and seven people in the seed roles. It prints
their passwords once. It refuses any other database: the environment must be
`development` or `test`, and the database must carry the marker that
`compose.dev.yaml` sets when it creates the database. `pnpm db:mark-dev` sets
the marker on a database made earlier. See [`demo`](../apps/api/src/demo/README.md).

## Typed client

`packages/api-client` is generated from the API's OpenAPI document:

```bash
pnpm client:generate   # builds the API, dumps packages/api-client/openapi.json,
                       # writes src/schema.ts and src/realtime-events.ts
pnpm client:check      # generates again and fails if git sees a difference
```

Run `client:generate` after a route or a schema changes and commit the result.
Never edit `openapi.json`, `schema.ts` or `realtime-events.ts`. A record add-on's
routes are in the document only when a feature uses the add-on. The client is
`openapi-fetch` over the generated types, plus the realtime (socket.io) client
([`packages/api-client/README.md`](../packages/api-client/README.md)).

## The web app

`apps/web` is Vite, React, TanStack Router and Query; its components are in
`packages/ui`. The rules for both are [`apps/web/AGENTS.md`](../apps/web/AGENTS.md).
`pnpm dev` serves it with Vite, which proxies the API's paths so that both share
one origin (`apps/web/dev-proxy.ts`). In production the API serves the build
from `WEB_ROOT` ([`core/web`](../apps/api/src/core/web/README.md)).

Scripts, with `pnpm --filter @nestjs-monorepo/web <script>`: `test` and `test:cov`
(Vitest, `*.test.tsx` next to the code), `typecheck`, `build`, `preview`, `size`
(bundle budget), `lighthouse` and `pwa:icons`. `packages/ui` has `storybook` and
`build-storybook`.

## Browser tests

`pnpm test:e2e:web` builds the API and the web app, then runs Playwright
(`apps/web-e2e`) on the built app against the built API. It needs the services
(`pnpm services:up`). The API it starts (`apps/web-e2e/scripts/api.mjs`) uses a
database of its own on that server, `app_browser_tests` (`E2E_DATABASE`),
created and marked for the demo seed when missing, so your development
database and its keys are left alone.

- `playwright.config.ts` starts the API on port 3300, which serves the built web
  app (`WEB_ROOT`, core/web) as in production: the page and the API share one
  origin, so the `__Host-sid` session cookie works, and the pages carry the
  API's real headers (a Content-Security-Policy violation fails a test). Outside
  CI an already running server is reused.
- The `setup` project signs in once per role with the seed's passwords (kept in
  `playwright/.auth/credentials.json`, ignored by git); the `chromium` project reuses
  that state. One worker, because the tests share one database.
- Tests check accessibility with axe: serious and critical findings fail a test.
  `pnpm --filter @nestjs-monorepo/web-e2e axe:summary` lists what a run attached.
- `E2E_BASE_URL`, `E2E_BROWSER_CHANNEL` (use the machine's Chrome) and
  `E2E_CREDENTIALS` change the defaults. Write a browser test only for a user flow
  the change adds or changes.
