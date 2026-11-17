# AGENTS.md

A NestJS 12 backend template: pnpm and Turborepo, the API in `apps/api`.
It is a rewrite of an earlier template (`nestjs-monorepo-template`): the same
capabilities, brought over one at a time in the structure below.
[PORTING.md](PORTING.md) lists what is here and what is still to come.

Before changing code in `apps/api`, read [apps/api/AGENTS.md](apps/api/AGENTS.md)
(NestJS's first-party packages and their docs).

## Rules

1. **First-party first.** Use the `@nestjs/*` package when one exists, the
   way its documentation shows. Otherwise the standard library for the job.
   Custom code only when nothing fits, with a comment saying why.
2. **One module, one folder.** A module owns its routes, services, tables
   (`*.tables.ts`), environment variables (`*.config.ts`), texts, tests and
   documentation. `app.module.ts` lists the modules; removing one is deleting
   its folder and its line there.
3. **No central file a module must edit.** No shared environment schema, no
   schema barrel, no hand-written registry. Tables are found by glob
   (`drizzle.config.ts`), extension points by decorators.
4. **Dependencies go one way:** `core` ← `iam` ← `modules` ← `features`. A
   module may use another of its own level only through what that one
   exports (its module, an exported service, its `forFeature()` or
   `forRecord()`), and only in one direction: no cycles, no reaching into
   another's internals. What would close a cycle is an event instead.
   `src/module-graph.spec.ts` enforces both.
5. **Each rule is written once.** A permission condition, a validation or a
   limit has one definition; everything else is derived from it.
6. **Nothing until it is needed.** No layer, base class, option or helper
   before a second real caller.
7. **Layers:** a controller does HTTP only, a service owns the logic and its
   queries, a module wires them.
8. **No raw SQL.** Drizzle's query builder; `sql` only for an expression it
   lacks.
9. **Generate, never hand-write what a command produces:** `pnpm add`,
   `nest g`, `pnpm db:generate`.
10. **Tests prove the change.** Unit tests next to the code; e2e tests run
    against a real PostgreSQL. A ported capability comes with its e2e tests.
11. **Versions are the newest, pinned exactly.** Drizzle comes from its `rc`
    tag.

## Decisions (the owner's, 2026-11-17)

- **The web app is served by the API** (`@nestjs/serve-static`): one image,
  one origin. No Caddy; HTTPS and certificates are the host's job.
- **Everything is on by default:** `app.module.ts` lists every module; an
  adopter deletes what they don't want.
- **Routes stay as they were** in the earlier template, so the web app, the
  typed client and the e2e tests carry over, except where a route was
  awkward: those are redesigned, and each change is listed in PORTING.md.
- **Tenancy is a seam.** Modules ask the tenancy module for the tenant's
  database and never know the isolation mode. Row-level security is the first
  strategy; schema-per-tenant and database-per-tenant are later strategies
  behind the same seam. Every tenant table keeps `tenant_id` in every mode,
  so a single-tenant project becomes multi-tenant by a switch, not a data
  migration.
- **Features come from a generator**, a Nest schematics collection (`nest g`).
- **Ported by dependency:** core, then tenancy, sign-in and access, then
  records and their add-ons, then the rest, then the web app and the client.
- **English only for now.** Texts still go through the translation catalogs
  (`<module>/i18n/en.json`), never hard-coded, so a language is added by
  adding catalogs and naming it in `LOCALES`.
- **Spreadsheets are `turbosheet`** (the owner's library): Excel and CSV,
  streaming, password-protected files. Imports and exports use it instead of
  separate CSV libraries; a gap in it is fixed upstream, not worked around.
- **Analytical reporting is not in the app.** The app keeps lists, exports
  and scheduled exports; dashboards over history belong in a store fed by
  replication.
- **Dynamic forms are ported last**, as a leaf module nothing depends on,
  sharing the field definitions of custom fields.
- **CASL stays as the rules engine**, in one file behind the access service;
  routes and services ask `@nestjs/authorization` policies. A condition is
  written once and its SQL derived from it.
- **Observability has two backends, swapped by configuration:** NestJS
  Observe (hosted) or Nestrix (the owner's open-source, self-hosted server).
  Modules use the OpenTelemetry API only, never a backend's SDK. Sentry is not
  ported. Gaps found in Nestrix are filed on its repository
  (nestrix-js/nestrix#49 tracks them), not worked around here.
- **No bundled operations:** no monitoring, backups, load tests, proxies or
  deploy pipelines.
- **Git:** local commits on `main`; no push and no pull request until the
  owner asks.

## Commands

```bash
pnpm install
pnpm services:up          # PostgreSQL (compose.dev.yaml)
cp apps/api/env.example apps/api/.env
pnpm dev                  # the API on http://localhost:3000
pnpm build && pnpm lint && pnpm test && pnpm test:e2e
```
