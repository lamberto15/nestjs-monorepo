# core/database

PostgreSQL 18 through Drizzle (`@nestjs/drizzle`), with transactions that
follow the call (nestjs-cls, `@nestjs-cls/transactional`).

- **In a service:** `@InjectTransaction() private readonly db: Database`
  (`database.ts`). Mark a write that must be atomic `@Transactional()`, or wrap
  it in `TransactionHost.withTransaction()`: every query it causes, in any
  service, joins the transaction. `@InjectDrizzle()` is the database outside
  any transaction (health checks, what must outlive a rollback).
- **Tables:** `uuidPk()`, `at()` and `...timestamps()` (`columns.ts`).
  `secretColumns(table, [columns])` (`secret-columns.ts`), next to the table,
  names the columns holding a credential or its hash: no copy of the data
  (a tenant's export) takes them.
- **Errors:** `databaseErrorKind(error)` (`database-errors.ts`):
  `unique_violation`, `foreign_key_violation`, `pool_exhausted`,
  `statement_timeout`, `read_only` (a frozen tenant or a break-glass read,
  core/tenancy), or undefined.
- **Migrations:** change a `*.tables.ts`, `pnpm db:generate`, commit
  `drizzle/`. Applied as the owner at start when MIGRATE_ON_START is on (the
  default outside production), else once per deploy with `node dist/migrate`;
  under an advisory lock either way, then the roles and the tenant wall
  (`migrateAll()`, `migrations.ts`).
- **Tenancy:** the pool is core/tenancy's (`isolation.connect()`): every
  query is bound to the tenant scope of its context.

## Roles

Three roles on one database (`roles.ts`, run after every migration):

- **DATABASE_URL**, the app's role (api, worker): no superuser, no
  BYPASSRLS, member of nothing, owns nothing, may CREATE nowhere; reads and
  writes every table of `public` and the owner's schemas. Made from its URL
  if missing; an existing role's attributes are checked, never changed. A
  superuser or BYPASSRLS role is refused at start.
- **DATABASE_OWNER_URL**, the owner: runs the migrations, makes the other
  roles (CREATEROLE is enough; a managed PostgreSQL's admin works). Only the
  migration needs it.
- **DATABASE_MAINTENANCE_URL**, the maintenance role (BYPASSRLS): cross-tenant
  maintenance (core/tenancy). Workers only. Only a superuser may create it:
  elsewhere make it once by hand, as the error says.

Development needs nothing: outside production, the owner defaults to
compose.dev.yaml's superuser and the maintenance role to
`app_maintenance`, both on 127.0.0.1:5432/app; the first start makes the
roles. Every URL must name DATABASE_URL's server and database.

Variables (`database.config.ts`): DATABASE_URL, DATABASE_OWNER_URL,
DATABASE_MAINTENANCE_URL, DATABASE_POOL_MAX (10),
DATABASE_POOL_TIMEOUT_MS (5000), DATABASE_STATEMENT_TIMEOUT_MS (30000),
DATABASE_IDLE_TX_TIMEOUT_MS (60000), DATABASE_APPLICATION_NAME (`api`),
MIGRATE_ON_START.

Tests: `database.e2e-spec.ts`, `migrations.e2e-spec.ts`, on the e2e harness
in `test/` (a template database per run, a copy per file, every app
connecting as the run's app role).
