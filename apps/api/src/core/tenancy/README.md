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
- **Queries:** `@InjectTransaction() db: Database`, as core/database says,
  with no tenant filter: the database binds every query to the scope.
- **`Tenancy`** (global): `tenantId()` (the current one, or
  `TenantScopeMissingError` → 403 `tenant_required`), `run(tenantId, work)`,
  `forEachTenant(job, work)`, `acrossTenants(job, work)` (maintenance that
  sweeps every tenant at once: the maintenance role, never in a request),
  `enter(tenantId)` (what sign-in's guard calls so the rest of the request
  runs in the tenant), `create()`, `find()`, `soleTenant()` (TENANCY=single).
- **Jobs:** queue `withTenant(data)`; consume with `TenantWorkerHost`
  (`handle()` runs in the job's tenant) or `inTenantOf(job.data, work)`.

## How it works (row-level security)

- Every tenant table has four policies (`tenant_id` equals the
  transaction-local `app.tenant_id`), row-level security enabled and forced.
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

## Variables

`TENANCY` (`multi` | `single`, `tenancy.config.ts`). The database roles'
URLs are core/database's.

## Tests

`tenancy.e2e-spec.ts` (the wall in SQL and through the app, pooled
connections, requests, work over tenants, the migrate-time check),
`tenant-job.e2e-spec.ts`, `single-tenant.e2e-spec.ts`; fixtures:
`test/fixtures/tenant-items*.ts`.

Not removable: the database's pool is this module's.
