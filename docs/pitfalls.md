# Pitfalls

Mistakes already made, or one line away. Each says what goes wrong, why, and
what to do.

## Database and tenancy

- **A query outside its transaction.**
  A service that injects `@InjectDrizzle()` runs outside the current
  transaction: it does not see the transaction's rows, waits on its locks, and
  its writes survive a rollback. Services inject `@InjectTransaction()` and mark
  an atomic write `@Transactional()`. Only a store that must stay outside
  (locks, secrets, idempotency, health checks) uses `@InjectDrizzle()`
  ([`core/database`](../apps/api/src/core/database/README.md)).
- **Work returned unawaited from a tenant scope runs without the tenant.**
  A Drizzle query runs when it is awaited, in the awaiter's context. A callback
  that returns the query without awaiting it leaves the scope before it runs,
  and the query fails with 403 `tenant_required`. `Tenancy.run()` awaits the work
  inside its scope; any other code that opens a context for a query must too.
- **A tenant table made with `pgTable`.** A table with a `tenant_id` that is not
  declared with `tenantTable()` or `globalTable()` has no row-level security
  policies, and the migration refuses to finish. Use `tenantTable()`, lead its
  uniques with `t.tenantId`, and never filter by tenant or set `tenantId` on insert
  ([`core/tenancy`](../apps/api/src/core/tenancy/README.md)).
- **The app's database role cannot create tables.** It owns nothing, on purpose.
  A table a test needs comes from a fixture migration
  (`pnpm --filter api db:generate:fixtures`), and a package that keeps its own
  schema (the outbox, the workflows) gets it from a migration run as the owner:
  after upgrading such a package, add a migration for its new schema version
  ([`core/outbox`](../apps/api/src/core/outbox/README.md)).
- **Concurrent `db:generate` mixes tables.** `drizzle-kit generate` reads every
  `src/**/*.tables.ts` in the working tree and diffs it against the last snapshot.
  A table another person or agent is editing in the same checkout lands in
  your migration. Generate where only your tables changed, and read the SQL
  before you commit.
- **A merged migration is edited or renamed.** Databases that applied it keep
  the old version and new ones get the new, so nobody notices. The migration lint
  fails the pull request ([ci.md](ci.md)). Two branches that changed the same
  tables conflict: delete your migration, merge, and run `pnpm --filter api db:generate`
  again.
- **A column dropped in the release that stops using it.** `migrate` runs before
  the new release starts, so old and new code share the schema for a while, and
  a rollback runs old code on the new schema. Stop using the column in one
  release and drop it in a later one. The migration lint reports drops,
  renames and retypes.
- **The pool is too small for parallel queries.** `Promise.all` of two queries
  outside a transaction takes two connections (a page and its count). With
  `DATABASE_POOL_MAX=1` such a request waits for itself and fails. Inside a
  transaction the queries run one after the other.
- **No raw SQL.** Whole statements through `sql` name tables and columns that no
  type check sees, so a rename breaks them at run time. Use the query builder;
  `pnpm raw-sql` counts what is left against `tools/ci/raw-sql.allow.json`.

## Permissions and the request pipeline

- **A route with no access check answers 403.** The authorization guard refuses
  a route that declares none of `@Can()`, `@Can.Anyone()` and `@Public()`. Declare
  one when you add the route.
- **No permission action is named `manage`.** CASL reads `manage` as every
  action, so a permission of that name would grant them all. The permission
  catalog throws at start. Name the action otherwise (`edit`, `configure`).
- **The order of global guards and interceptors is the order of the modules in
  `app.module.ts`.** The rate limit comes before sign-in, sign-in before the access
  check, and idempotency is the outermost interceptor, with usage metering inside
  it and the retries of outbound calls innermost. A replay passes through no other
  interceptor, so it is neither metered nor held to a quota. A module with a
  global guard or interceptor goes where its comment in `app.module.ts` says, and
  a module that imports `AccessModule` goes after `AuthModule`. At boot,
  `@nestjs/idempotency` warns that its interceptor runs inside others. Three
  are expected there, in any order: `I18nInterceptor` (the language),
  `NestrixInterceptor` (the trace) and `Object` (nestjs-cls's pass-through).
  Another name in the warning means a global interceptor got in front of
  idempotency; `src/app.module.e2e-spec.ts` boots every module and fails then.
- **Global guards and interceptors also run on non-HTTP contexts.** Each tool
  call of the MCP endpoint (`POST /v1/mcp`) goes through them again with context
  type `'mcp'`, and sockets use `'ws'`. Code that reads the request must check
  `context.getType()` first, as the throttle, usage and principal guards do. A
  new global guard that assumes HTTP breaks MCP calls
  ([`modules/mcp`](../apps/api/src/modules/mcp/README.md)).
- **A route guard named like authentication.** `@nestjs/authorization` checks
  the guard order at start and goes by class name for guards that are not
  `@nestjs/authentication`'s: a name with `auth` (not followed by `or` or `z`),
  `jwt` or `api-key` is taken for one that authenticates, and the log claims
  `@Can()` sees every caller as a guest. Name a route guard that does not
  authenticate without those words (`RecentSignInGuard`), and treat the message as
  real for one that does.
- **Everything an operator needs to leave maintenance mode must be
  `@AllowInMaintenance()`.** That is every way to sign in, the operators' routes
  that end the mode, and the tenant switch that reaches them. One route left out
  strands the operator behind the 503, with only the CLI to end it
  ([`modules/mode`](../apps/api/src/modules/mode/README.md)).
- **A new unversioned route answers the web page.** The API serves the built web
  app on every GET it does not own. A route outside `/v1` must be added to
  `API_PATHS` in `core/web/web.config.ts`
  ([`core/web`](../apps/api/src/core/web/README.md)).
- **A route a monitor polls must skip the rate limit.** The limiter counts in
  Redis, and its commands wait while Redis is down, so a throttled `/health` or
  `/metrics` hangs exactly when it is needed. Keep `@SkipThrottle()` on them.
- **An event nothing subscribes to is not written.** The outbox retries a message
  that has no handler and holds back the later events of its key, so
  `events.publish()` skips an event type with no `@OnDomainEvent` subscriber. A
  test that expects the event needs its subscriber in the booted modules.
  `events.publish()` also throws outside a transaction
  ([`core/outbox`](../apps/api/src/core/outbox/README.md)).
- **No one runs the jobs.** Queue workers, the outbox relay and scheduled jobs run
  only where `APP_ROLE` is `worker` or `all`. A deployment of `APP_ROLE=api`
  instances needs at least one worker process (`node dist/worker`), or mail and
  webhooks wait for ever ([`core/queues`](../apps/api/src/core/queues/README.md)).
- **Password hashes are limited per process.** scrypt takes about 128 MiB per
  hash outside the V8 heap, and a burst of sign-ins once killed a container by its
  memory limit. Every hash goes through `PasswordHashLimiter`
  (`PASSWORD_HASH_CONCURRENCY`; past its queue, 503 `server_busy`). Never hash
  with `node:crypto` directly, and never lower the scrypt parameters to save
  memory. A flow that consumes something (a reset link) and then hashes takes the
  slot first (`limiter.run()`), or a 503 there would spend the link.
- **The access cache is per process.** Abilities are cached for up to a minute.
  After any change to roles, grants or unit memberships call `access.invalidate()`:
  it reaches every instance through Redis.
- **Log redaction is declared at import time.** The logger takes a snapshot of the
  registry in `core/logging/redaction.ts` when it is created. Declaring a secret
  later, from a constructor or a lifecycle hook, throws. Declare at module scope,
  next to what makes the secret.

## Tests

- **A testing module compiled before its HTTP adapter exists serves no static
  files.** `bootModules()` compiles the module and then creates the app, and
  `@nestjs/serve-static` chooses how to serve from the adapter it finds when it
  is compiled: none, so nothing. A test of `core/web` creates the app as `main.ts`
  does, with `NestFactory.create(…, createHttpAdapter())` (`core/web/web.e2e-spec.ts`).
- **Environment variables set too late.** A test sets the variables a module reads
  (`SCHEDULER`, `OUTBOX_RELAY`, `WEBHOOKS_WORKER`, `IDEMPOTENCY`, `APP_ROLE`,
  `DATA_ENCRYPTION_KEYS`…) in `vi.hoisted()`, which runs before the file's imports.
  A `beforeAll` is too late, and each file has its own environment, so two
  settings of one variable need two files. The helpers in `apps/api/test` name the
  ones they need.
- **Overriding a provider does not stop its original factory.** A test that
  replaces a provider still runs the factory it replaced, with its side effects.
  `setup-env.ts` sets `MIGRATE_ON_START=off` for that reason. After changing test
  plumbing, run once against a server you can inspect (`TEST_DATABASE_URL` at a
  throwaway database) and look at what it left.
- **A killed run leaves databases and roles.** The global teardown drops the
  template, every copy and the run's roles; a run killed before it leaves
  `e2e_<id>_…` databases and roles on the server. Drop them.
- **Turborepo hides variables.** In its strict mode a task sees the system's
  variables and the ones `turbo.json` names. `pnpm test:e2e` passes
  `TEST_DATABASE_URL` and `TEST_LOGS` only; another (`REDIS_URL`) is not seen.
  Run `pnpm --filter api test:e2e` to skip Turborepo, or add the name to
  `passThroughEnv` (an `env` entry for a build input).
- **Webhooks to `127.0.0.1` are refused.** Delivery to the loopback address needs
  `WEBHOOKS_ALLOW_LOOPBACK=on`, for development and tests only
  ([`modules/webhooks`](../apps/api/src/modules/webhooks/README.md)).

## Processes and shutdown

- **Shutdown hangs when Redis is gone.** The shared ioredis clients queue commands
  while Redis is away (`maxRetriesPerRequest: null`, which BullMQ's workers need),
  so `quit()` waits behind them for ever. Close a client with `closeRedis()`
  (`core/redis/redis.ts`), never `quit()`. The queues' producer connections have no
  offline queue; `closeWhenRedisIsDown()` in `core/queues/queues.ts` is what lets
  them close, so do not remove it.
- **Queue workers close before the Redis client and the pool.** Nest closes the
  HTTP server and sockets first, then the modules. `QueueWorkers` closes the
  workers in `beforeApplicationShutdown` so a running job finishes while the
  database and Redis are still open. Keep a new worker registered there.

## Web tests

- **Devtools mounted under Vitest made the web suite take half an hour.**
  `import.meta.env.DEV` is true in a test run, so the router and query
  devtools mounted with every rendered app. Each mount injects a stylesheet,
  and jsdom walks every CSS rule for each `getByRole` (it asks whether an
  element is hidden): a file's first test took 2 s and its last 35 s. The
  root route now also checks `import.meta.env.MODE !== 'test'`; the suite
  runs in about a minute. When tests get slower one after another, take a CPU
  profile (`vitest run --pool=forks --no-file-parallelism --execArgv=--cpu-prof`)
  before blaming the machine.
