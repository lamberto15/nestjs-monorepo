# src/demo

The demo seed: `pnpm db:seed:demo` fills a development database with a demo
tenant ("Demo Company", slug `demo`), three organizational units (Sales, Sales
North under it, Engineering) and seven people in the template's seed roles:
an administrator (also an editor), two unit leads, three editors and a viewer.
The web app's browser tests sign in as these accounts
(`apps/web-e2e/scripts/api.mjs` keeps the passwords the seed prints).

It is its own entry (`seed-demo.ts`, built to `dist/demo/seed-demo.js`), never part of
the API or the worker: the app plus `DemoModule`, as APP_ROLE=api.

- **Only on a development database.** Both must hold, checked before anything
  is written (`demo.guard.ts`): NODE_ENV is `development` or `test` (an unset one
  is refused), and the database carries the marker `app.dev_database = on`. The
  marker is a database-wide setting only a superuser or the database's owner can
  write; the development services set it when they create their database
  (`tools/dev/10-dev-database.sql`), and `pnpm db:mark-dev` sets it on one made before.
- **Once.** A database that has the demo tenant or demo users is left as it is.
- **Through services.** The tenant and its roles come from
  `TenantsService.makeTenant()`, the units from `OrganizationService` (audited, the
  actor the system job `demo-seed`), the unit memberships as the demo
  administrator. People are inserted directly (adding people through the API is
  invitation-only) with verified addresses at `demo.example.com` and generated
  passwords, printed once to stdout and never logged.
- **TENANCY=single:** the one tenant there is (the operators', made by the first
  start) is filled, and its administrator acts as an operator.
- The operators' tenant and first administrator are not made here: the first
  start of any process makes them (iam/access, `AccessSeeder`).

A module with demo data of its own adds it later by its own seeder; this one
has no sample feature to fill.

Tests: `demo.guard.spec.ts`, `demo.e2e-spec.ts`.
