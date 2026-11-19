# core/tenancy

The wall between tenants. A tenant is a customer; its rows are seen and
written only in its scope. Modules never know how the wall is built.

## In a module

- **Tables:** `tenantTable(name, columns, extras?, { referenced? })`
  (`tenant-tables.ts`) instead of `pgTable`: it adds `tenantId` and the wall.
  Uniques lead with `t.tenantId`. A key to another tenant table is
  `tenantReference()` (composite, so it can't point into another tenant),
  and the table it points at is declared `{ referenced: true }`. Then
  `pnpm db:generate`. Inserts leave `tenantId` out: it comes from the scope.
- **Tables that name a tenant but are not walled:** `globalTable()` for a
  table read across tenants (memberships, API keys: looked up before the
  tenant is known); its `tenantId` is required and never comes from the
  scope. `tenantTable(..., { nullRows: 'outside' })` for a tenant table
  with rows of no tenant (the audit log): a tenant sees its own, work outside
  every tenant sees the rows of none.
- **Queries:** `@InjectTransaction() db: Database`, as core/database says,
  with no tenant filter: the database binds every query to the scope.
- **`Tenancy`** (global): `tenantId()` (the current one, or
  `TenantScopeMissingError` → 403 `tenant_required`), `run(tenantId, work)`,
  `forEachTenant(job, work)` (each active tenant in its scope; one's failure
  does not stop the others, then `TenantRunsFailed` names them),
  `acrossTenants(job, work)` (maintenance that sweeps every tenant at once:
  the maintenance role, never in a request; the job's first run in the
  process is logged, its repeats only at debug),
  `enter(tenantId, { readOnly? })` (what sign-in's guard calls so the rest
  of the request runs in the tenant; `readOnly` for a break-glass read), `create()`, `find()`, `soleTenant()` (TENANCY=single).
- **Jobs:** queue `withTenant(data)`; consume with `TenantWorkerHost`
  (`handle()` runs in the job's tenant) or `inTenantOf(job.data, work)`.

## How it works (row-level security)

- Every tenant table has four policies (`tenant_id` equals the
  transaction-local `app.tenant_id`; with `nullRows`, or both are null),
  row-level security enabled and forced. A global table has one
  `<table>_global` policy. The migrate-time check tells them apart by that
  policy and by whether `tenant_id` is required.
- The app's pool (`row-level-security.ts`, used by DatabaseModule) sends
  every `begin` with `set_config('app.tenant_id', <scope's tenant or ''>,
true)`; a query outside a transaction in a tenant's scope gets a
  transaction of its own; without a tenant it runs unbound, so it sees no
  row and writes none. A connection given back inside a transaction is
  closed. The scope lives in nestjs-cls (AsyncLocalStorage); every request
  has a context of its own (the CLS middleware).
- Roles (core/database/README.md, "Roles"): the app's role is no superuser,
  has no BYPASSRLS and owns nothing (checked at every start and every
  migration); the migrations run as the owner, then force row-level
  security and refuse a tenant table whose policies differ from the
  declaration (an `ALTER POLICY` by hand, a table with `tenant_id` made
  without `tenantTable()`). Cross-tenant work runs as the maintenance role
  (BYPASSRLS), whose pool only exists where DATABASE_MAINTENANCE_URL is set.
- **Read only** (`readOnly` on the scope: `enter(tenantId, { readOnly: true })`,
  an operator's break-glass request): every transaction begins with `set
transaction read only` before its setting, so PostgreSQL refuses any write
  (25006), a global table's too, and it can't be made read-write again. A
  query outside a transaction gets a read-only one of its own, even without
  a tenant; a checked-out connection runs nothing outside a transaction.
  Work nested in it stays read only (`run()`, `inTenantOf()`, a second
  `enter()`), and `acrossTenants()` is refused.
- What it does not stop: SQL injected into a request runs as the app role and
  may set `app.tenant_id` itself. The wall is against bugs in correct
  queries; parameters are against injection.

## Other isolation modes

Everything that depends on the mode is `TenantIsolation`
(`tenant-isolation.ts`), with one implementation. Another mode implements
the same four members: **schema-per-tenant** — `tableWall` declares nothing,
`connect` sets `search_path` to the tenant's schema at each `begin`,
`provision` creates the schema and migrates it, `secure` checks every
tenant schema is at the current migration, and cross-tenant work loops over
schemas. **Database-per-tenant** — `connect` keeps a pool per tenant and
picks it by scope, `provision` creates and migrates a database, `secure`
migrates each. `tenant_id` stays on every table in every mode.

## Frozen tenants

A tenant whose `frozen_at` is set is read only: the `begin` of each of its
transactions also runs `set_config('transaction_read_only', 'on', true)`
when the tenant's row is frozen, so every write of it fails in PostgreSQL
(25006, answered 503 `tenant_read_only`), from every instance, request and
job, and its reads go on. `Tenancy.setFrozen()` sets it; a move uses it
(modules/tenant-move). `Tenancy.restore()` puts back a tenant moved from
another server with its id (with `TENANCY=single`, only into a server with no
tenant yet).

## Variables

`TENANCY` (`multi` | `single`, `tenancy.config.ts`). `FIRST_START_SEED`
(`on`): the first start of a server with no tenant makes the default one
(and the access seed its administrator); the operator CLI sets it `off`, so
a server about to take a moved tenant stays empty. The database roles'
URLs are core/database's.

## Tests

`tenancy.e2e-spec.ts` (the wall in SQL and through the app, pooled
connections, requests, work over tenants, the migrate-time check),
`tenant-job.e2e-spec.ts`, `single-tenant.e2e-spec.ts`, `tenant-tables.e2e-spec.ts`
(global and nullRows tables); fixtures:
`test/fixtures/tenant-items*.ts`.

Not removable: the database's pool is this module's.
