# Getting started

From a copy of this template to a product of your own: start the project,
run it, sign in, choose the tenancy, drop what you don't need, add your first
feature, and ship the image. Each step links to the page that has the detail.

## 1. What you get

A NestJS 12 API (`apps/api`), a web app it serves (`apps/web`, components in
`packages/ui`), a typed client generated from the API (`packages/api-client`)
and the repository's tools (`tools/`), in one pnpm and Turborepo workspace.
The API is modules in four levels: `core` (always there: configuration,
database, tenancy, HTTP conventions, queues, mail), `iam` (sign-in, accounts,
tenants, roles and permissions, audit), `modules` (records and their add-ons,
settings, notifications, webhooks, search, imports and exports, and the rest)
and `features`, which starts empty and holds your business records
([architecture](architecture.md)).

**Everything is on.** `apps/api/src/app.module.ts` lists every module, and
the web app has a page for each. You delete what you don't want (step 5);
you never switch something on.

## 2. Start a project from the template

Copy it with a history of its own:

```bash
git clone --depth 1 <the template's URL> my-app
cd my-app
rm -rf .git
git init -b main
pnpm install                 # also installs the git hooks, which need .git
git add -A
git commit -m "chore: start from the template"
```

The commit hook checks Conventional Commits (`type(scope): subject`).

### The licence

The template is licensed under the
[PolyForm Noncommercial License 1.0.0](../LICENSE) (`LICENSE`, and `license`
in every `package.json`). That licence does not allow commercial use. If your
product is commercial, get a licence from the licensor before you build on it.

### Renaming

There is no rename command. What carries the template's name:

| What                         | Where                                                                                                                                       | Change it?                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The root package             | `package.json` (`"name": "nestjs-monorepo"`), the title of `README.md`                                                                      | Yes.                                                                                                                                                                                           |
| The development services     | `compose.dev.yaml` (`name: nestjs-monorepo-dev`)                                                                                            | Yes, if another copy of the template runs on the same machine: the same name shares the containers and volumes. Both also bind ports 5432 and 6379.                                            |
| The workspace scope          | `@nestjs-monorepo/*`: the `name` of `apps/web`, `apps/web-e2e`, `packages/ui`, `packages/api-client`, and every import of them (`pnpm-lock.yaml`, `turbo.json`, `Dockerfile`, `.github/workflows/ci.yml`, the generator's web templates) | Optional: the packages are private and never published. To change it, replace the string in every tracked file, run `pnpm install && pnpm build && pnpm test`, and commit (`pnpm client:check` compares the client with what is committed).                                  |
| The name people see          | `apps/web/src/locales/en/common.json` (`app.name`), `apps/web/index.html` (`<title>`), `apps/web/vite.config.ts` (the PWA manifest's `name`, `short_name`, `description`, `theme_color`) | Yes.                                                                                                                                                                                           |
| The API's name               | `API_TITLE` in `apps/api/src/core/http/openapi.ts` (`My API`; then `pnpm client:generate`); `MAIL_FROM` and `SERVICE_NAME` in the environment (authenticator apps and passkeys show `SERVICE_NAME`) | Yes.                                                                                                                                                                                           |
| The image                    | `.github/workflows/publish.yml` publishes `ghcr.io/<owner>/<repo>`, taken from the repository                                                | Nothing to edit.                                                                                                                                                                               |
| Internal labels              | an advisory lock name in `core/database/roles.ts`, the cursor key label in `core/http/cursor-seal.ts`, the schematic's `$id`                | No: nobody sees them, and the cursor label is part of every list cursor.                                                                                                                       |

The scope's replacement, for example to `@acme/` (macOS `sed`; GNU `sed`
takes `-i` without `''`):

```bash
git grep -l '@nestjs-monorepo/' | xargs sed -i '' 's#@nestjs-monorepo/#@acme/#g'
```

`AGENTS.md` (read by coding agents through `CLAUDE.md`) holds the rules the
code follows and the template owner's decisions. Keep the rules; make the
decisions yours.

## 3. Run it locally

Node 26 or later, Docker, and pnpm (the version `packageManager` pins).

```bash
pnpm install
pnpm services:up          # PostgreSQL and Redis (compose.dev.yaml)
pnpm run setup            # writes apps/api/.env, with generated keys
pnpm dev                  # the API on http://localhost:3000, the web app on http://localhost:5173
pnpm traces:up            # optional: Nestrix on http://localhost:4318, to see where requests spend their time
```

`pnpm run setup` prints:

```text
Writing …/apps/api/.env from env.example.
Generated (not shown): DATA_ENCRYPTION_KEYS, BLIND_INDEX_KEYS, CURSOR_KEYS.
Set for development: WEB_URL=http://localhost:5173.
Wrote …/apps/api/.env.
ok: every REQUIRED variable is set.
```

`pnpm dev` builds the shared packages first and starts both apps; `WEB_URL`
sends the links in mails to the web app's port. Both are explained in
[development, "Setup"](development.md#setup).

Worth adding to `apps/api/.env` before the first start: `ADMIN_EMAIL` and
`ADMIN_PASSWORD` (below).

To see each request's queries and timings while you use the app, start
Nestrix (`pnpm traces:up`) and set `OTEL_EXPORTER_OTLP_ENDPOINT` in
`apps/api/.env`: [development, "Traces"](development.md#traces).

### The first sign-in

The first start (no user yet, `FIRST_START_SEED=on`) makes the first tenant,
its roles and the first administrator (`iam/access`, `AccessSeeder`). The
API's log says:

```text
LOG [Access] Seeded the tenant "Operators" and its roles: administrator, editor, unit-lead, viewer.
WARN [Access] Created the first administrator admin@example.com with password a1RryBezlTZ_A11OGdQbPzHe (shown once; set ADMIN_PASSWORD to choose it, and change it after signing in).
```

Open http://localhost:5173 and sign in with that address and password. With
the defaults (`ADMIN_EMAIL=admin@example.com`, no `ADMIN_PASSWORD`,
`ADMIN_ONBOARDING=on`) the account must first replace both: every route but
the account's own answers 403 `onboarding_required` until it has

1. changed the password;
2. replaced the address with one that is not a placeholder (`example.com`,
   `.test`, `.localhost` and the other reserved domains are refused);
3. opened the verification link mailed to the new address. In development
   mail is written to files (`MAIL_TRANSPORT=file`):
   `apps/api/.data/mail/*.eml`.

The web app walks through these. To skip them, set `ADMIN_EMAIL` to a real
address and `ADMIN_PASSWORD` before the first start: the seeded account is
then verified and done. The same steps with curl:

```bash
curl -c jar -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"<the logged password>"}' \
  http://localhost:3000/v1/auth/sign-in          # {"signedIn":true,"mfaRequired":false}
curl -b jar -c jar -H 'content-type: application/json' \
  -d '{"currentPassword":"<the logged password>","newPassword":"<a new one>"}' \
  http://localhost:3000/v1/auth/password/change   # 204
curl -b jar -H 'content-type: application/json' \
  -d '{"email":"you@your-domain.com","currentPassword":"<the new one>"}' \
  http://localhost:3000/v1/auth/email/change      # {"accepted":true}
curl -H 'content-type: application/json' \
  -d '{"token":"<the token in the mail link>","password":"<the new one>"}' \
  http://localhost:3000/v1/auth/email/verify      # {"email":…,"emailVerified":true}
curl -b jar http://localhost:3000/v1/access/roles # the roles: onboarding is done
```

A lost password: `pnpm ops user:reset-password <email>`
([the operator CLI](../apps/api/src/cli/README.md)).

### Demo data

```bash
pnpm db:seed:demo
```

It builds the API and fills the development database with a tenant "Demo
Company" (slug `demo`), three units and seven people, and prints their
passwords once:

```text
Demo data in the tenant "Demo Company": 7 users, 3 units. Their passwords, shown once:

  noah.fischer@demo.example.com  …  Noah Fischer (Administrator, Editor)
  maya.patel@demo.example.com    …  Maya Patel (Editor, Unit lead)
  …
  elena.novak@demo.example.com   …  Elena Novak (Viewer)
```

It runs only on a development database ([`demo`](../apps/api/src/demo/README.md));
one made before the services marked theirs needs `pnpm db:mark-dev` first.

## 4. Choose the tenancy

`TENANCY` in `apps/api/.env` ([`core/tenancy`](../apps/api/src/core/tenancy/README.md),
[identity](identity.md#tenants)):

- **`multi`** (the default): many customers on one deployment, each a
  tenant. The first start makes the operators' tenant, named by
  `ADMIN_TENANT_NAME` (`Operators`, slug `operators`). Its members are the
  deployment's operators only when `OPERATOR_TENANT` names it: set
  `OPERATOR_TENANT=operators`, or nobody may use the routes that reach past
  one tenant. Customers' tenants come from `pnpm ops tenant:create <slug> -a
  <email>`, or from self sign-up (`AUTH_SIGN_UP=on` and `TENANT_SIGN_UP=on`).
- **`single`**: one tenant (`Default`, slug `default`), made at the first
  start; no other can be made, and its administrator is the operator.

Choose before the first start, since it decides the first tenant. Every
tenant table keeps `tenant_id` and row-level security in both modes, so a
later switch is this variable alone, with no data migration.

A customer of a shared deployment that needs a server of its own gets the
same image there, usually with `TENANCY=single`, and its tenant moves with
three CLI commands: [moving a tenant](moving-a-tenant.md).

## 5. Trim what you don't need

Do this early, before there is data: removing a module drops its tables.

```bash
pnpm module:list
```

lists every module above `core` and who uses it:

```text
modules/forms             removable
modules/tags              removable
modules/storage           used by modules/attachments, modules/branding, modules/data-transfer, …
…
```

A `removable` module can go now; for the others, remove what uses them first.
Then, for one module:

```bash
pnpm module:remove forms             # a dry run: nothing changes
pnpm module:remove forms --apply     # does it
```

The dry run lists the folder, the `app.module.ts` lines, the tables it drops,
its variables, its routes, its web pages and texts, its blocks in shared web
files, and the docs and `PORTING.md` lines that name it. `--apply` deletes
them and regenerates what was derived from them: the migration
(`drizzle/<timestamp>_remove-forms`), `env.example`, the typed client and the
web route tree. It ends with:

```text
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
  apps/api/drizzle/…_remove-forms/migration.sql DROPS forms, form_versions, form_submissions, form_public_links.
  Applied on the next deploy, it deletes those tables WITH THEIR DATA.
  Export what must be kept first. Read the SQL before committing.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
```

In development the next start applies that migration. Review the
`PORTING.md` lines it lists, run `pnpm build && pnpm lint && pnpm test &&
pnpm test:e2e`, and commit the removal with what was regenerated. What it
refuses and why: [removing a module](removing-a-module.md).

## 6. Add your first feature

A feature is a business record: its table, routes, permissions, tests and web
pages, in `apps/api/src/features/<name>/` and one line of `app.module.ts`.
From the root:

```bash
pnpm feature:add customers \
  --fields "name:string,email:string?,tier:enum(free|pro|enterprise),notes:text?" \
  --addons tags,comments
```

It writes the API's twelve files (`customer.record.ts`, `customers.tables.ts`,
`customer.schemas.ts`, `customer.list.ts`, `customer.permissions.ts`,
`customer.policy.ts`, `customers.service.ts`, `customers.controller.ts`,
`customers.module.ts`, `i18n/en.json`, `customers.e2e-spec.ts`, `README.md`),
the web pages (`apps/web/src/features/customers/`,
`apps/web/src/routes/_app/customers/`, `apps/web/src/locales/en/customers.json`),
the module's line in `app.module.ts` and the route tree. The options (field
types, add-ons, the recycle bin, units, grants):
[adding a feature](adding-a-feature.md).

Then:

```bash
pnpm --filter api db:generate --name customers                           # the table's migration
pnpm --filter api test:e2e src/features/customers/customers.e2e-spec.ts  # the routes and each add-on
pnpm --filter @nestjs-monorepo/web test src/features/customers           # the pages
pnpm client:generate                                                     # the typed client the pages use
```

Read the migration: it creates the table with its row-level security
policies. The generated tests pass as generated.
Restart `pnpm dev`: the API serves `/v1/customers` and the web app has the
pages. A create takes an `Idempotency-Key` header
(`IDEMPOTENCY=required`, the default; the web app sends one):

```bash
curl -b jar -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"name":"Acme","tier":"pro"}' http://localhost:3000/v1/customers
```

**Your code** goes where the generated files say "Business logic": checks
before a write in the service, rules that must hold on every write in a
`@RecordExtension()` provider, who may do what in the permissions and the
policy, and the texts in `i18n/en.json`. Each change comes with its test in
the feature's own e2e spec. A field changes in `<item>.record.ts`, then
`pnpm --filter api db:generate`. The contract behind the files:
[`modules/records`](../apps/api/src/modules/records/README.md), "Writing a
feature".

## 7. Everyday work

The commands and how the tests run: [development](development.md).

- **Tests.** Unit tests sit next to the code (`*.spec.ts`, `pnpm test`); e2e
  tests (`*.e2e-spec.ts`, `pnpm test:e2e`) run against the real PostgreSQL
  and Redis, a database copy per file.
- **Migrations.** Change a `*.tables.ts`, run `pnpm --filter api db:generate`,
  read the SQL, commit both. Never edit a merged migration.
- **The typed client.** After a route or schema change, `pnpm client:generate`
  and commit the result; `pnpm client:check` (CI) fails when it is stale.
- **Environment variables.** A module declares its own in its `*.config.ts`;
  `pnpm env:example` regenerates `apps/api/env.example`, which is never
  edited by hand.
- **Git hooks.** Prettier, oxlint and the raw SQL check on staged files, and
  commitlint on the message.
- **The rules** that matter most day to day ([AGENTS.md](../AGENTS.md)): a
  module owns everything in its folder; dependencies go
  `core` ← `iam` ← `modules` ← `features`; no raw SQL; generate what a
  command produces; a change comes with the tests that prove it. Mistakes
  already made: [pitfalls](pitfalls.md).

## 8. Deploy

The repository builds one image and describes what it needs; the platform
around it is yours ([deployment](deployment.md)).

- **The image.** `docker build -t app .` at the root builds the API with the
  web app inside. One image, three commands: `node dist/main` (the API, the
  default), `node dist/worker` (queues and scheduled jobs) and
  `node dist/migrate` (once per deploy, before the new release starts).
- **Publishing.** Once CI passes on a push to `main`, `publish.yml` pushes
  `ghcr.io/<owner>/<repo>:sha-<commit>` and points `main` at it; a tag
  `v1.2.3` gives that image `1.2.3` and `1.2`. Nothing deploys it
  ([ci](ci.md)).
- **What a deployment needs.** PostgreSQL 18, Redis 7, the three database
  URLs, `APP_URL`, `DATA_ENCRYPTION_KEYS` and `BLIND_INDEX_KEYS`, mail and
  storage, `APP_ROLE` per process: [deployment](deployment.md#what-a-production-start-needs).
  Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` for the first start there too.
- **Secrets as files.** Each variable marked `Secret` in `env.example` also
  takes `<NAME>_FILE`, the path of a file holding it (a Docker or Kubernetes
  secret).

## 9. Where to read next

The map in [AGENTS.md](../AGENTS.md#map): [architecture](architecture.md),
[development](development.md), [adding a feature](adding-a-feature.md),
[removing a module](removing-a-module.md), [API conventions](api-conventions.md),
[identity](identity.md), [background work](background-work.md),
[deployment](deployment.md), [moving a tenant](moving-a-tenant.md),
[ci](ci.md) and [pitfalls](pitfalls.md). Each module's own reference is its
`README.md` under `apps/api/src/{core,iam,modules}/<name>/`.
