# core/database

PostgreSQL 18 through Drizzle (`@nestjs/drizzle`), with transactions that
follow the call (nestjs-cls, `@nestjs-cls/transactional`).

- **In a service:** `@InjectTransaction() private readonly db: Database`
  (`database.ts`). Mark a write that must be atomic `@Transactional()`, or wrap
  it in `TransactionHost.withTransaction()`: every query it causes, in any
  service, joins the transaction. `@InjectDrizzle()` is the database outside
  any transaction (health checks, what must outlive a rollback).
- **Tables:** `uuidPk()`, `at()` and `...timestamps()` (`columns.ts`).
- **Errors:** `databaseErrorKind(error)` (`database-errors.ts`):
  `unique_violation`, `foreign_key_violation`, `pool_exhausted`,
  `statement_timeout`, or undefined.
- **Migrations:** change a `*.tables.ts`, `pnpm db:generate`, commit
  `drizzle/`. Applied at start when MIGRATE_ON_START is on (the default outside
  production), else once per deploy with `node dist/migrate`; under an
  advisory lock either way (`migrations.ts`).

Variables (`database.config.ts`): DATABASE_URL, DATABASE_POOL_MAX,
DATABASE_POOL_TIMEOUT_MS, DATABASE_STATEMENT_TIMEOUT_MS,
DATABASE_IDLE_TX_TIMEOUT_MS, DATABASE_APPLICATION_NAME, MIGRATE_ON_START.

Tests: `database.e2e-spec.ts`, `migrations.e2e-spec.ts`, on the e2e harness
in `test/` (a template database per run, a copy per file).
