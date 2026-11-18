# Architecture

Where things are, how the API is layered, and how a request travels through
it. Each module's README is the reference for that module; this page says how
they fit together.

## The repository

| Path                  | What it is                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/api`            | The NestJS API: every module, the migrations (`drizzle/`), the feature generator (`schematics/`).              |
| `apps/web`            | The web app (Vite, React, TanStack Router and Query). The API serves its build.                                |
| `apps/web-e2e`        | Playwright tests of the built web app against the built API.                                                   |
| `packages/ui`         | The web app's components.                                                                                      |
| `packages/api-client` | The typed client: types generated from the API's OpenAPI document, plus the realtime client.                   |
| `tools`               | Repository scripts: setup, `env.example` generation, removing a module, the raw SQL check, the migration lint. |

The workspace is pnpm and Turborepo (`pnpm-workspace.yaml`, `turbo.json`). Commands
run from the root: [development.md](development.md).

## The four levels of the API

`apps/api/src` has four folders, and a folder is a level:

- `core/<name>`: always there. Configuration, database, tenancy, HTTP
  conventions, queues, outbox, mail, logging.
- `iam/<name>`: who is calling and what they may do. Sign-in, accounts,
  tenants, access, audit.
- `modules/<name>`: optional capabilities. Records and their add-ons,
  settings, notifications, webhooks, search.
- `features/<name>`: your business features. The folder starts empty
  ([`features/README.md`](../apps/api/src/features/README.md)).

Imports go one way: `core` <- `iam` <- `modules` <- `features`. A level never
imports a higher one. Inside a level, a module may use another only through
what that one exports (its module, an exported service, its `forFeature()` or
`forRecord()`), and only in one direction. What would close a cycle is an
event instead (below).

`src/module-graph.spec.ts` enforces it. It reads the relative imports of every
non-test file and fails on an import of a higher level and on a cycle between
modules above `core` (`core` counts as one unit). It does not check that an
import goes through an export: that is a review rule.

## What a module owns

A module is one folder. It holds its routes, services, tests and documentation,
and these files:

- `<name>.tables.ts`: its tables. `drizzle.config.ts` finds them by glob
  (`src/**/*.tables.ts`), so no schema file lists them.
- `<name>.config.ts`: its environment variables, checked at start. Nothing else
  reads `process.env`. `apps/api/env.example` is generated from these files
  ([`core/config`](../apps/api/src/core/config/README.md)).
- `i18n/en.json`: its texts. Code never hard-codes a message
  ([`core/i18n`](../apps/api/src/core/i18n/README.md)).
- `*.spec.ts` (unit) and `<name>.e2e-spec.ts` (against a real PostgreSQL and Redis).
- `README.md`: what it does, its variables and routes, its extension points
  and how to remove it.

`app.module.ts` lists the modules and is the only file that names them. Adding
a module is one line there. Removing one is deleting its folder and that line.
If a module seems to need a line in another module's file, it needs an event or
a discovery decorator instead.

## How modules extend each other

A lower module cannot import the module that extends it, so the extender marks
a provider and the lower module finds it at start.

**Discovery decorators.** Each is made with `DiscoveryService.createDecorator`
in the file shown. The lower module defines the contract, a higher (or
sibling) module implements it.

| Decorator                               | Defined in                                          | What a provider gives                                |
| --------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `@ReadinessCheck(name)`                 | `core/health/readiness.ts`                          | A check of `GET /health`.                            |
| `@Feature(shape)`                       | `core/http/feature.ts`                              | A switch of `GET /v1/features`.                      |
| `@EncryptedColumns()`                   | `core/encryption/encrypted-columns.ts`              | The encrypted columns it owns.                       |
| `@MailBrand()`                          | `core/mail/mail-brand.ts`                           | The tenant's mail brand.                             |
| `@MailDeliveryPolicy()`                 | `core/mail/mail-delivery.ts`                        | Mail delivery mode and daily budget.                 |
| `@MailSuppressionList()`                | `core/mail/mail-suppression.ts`                     | Which addresses mail must skip.                      |
| `@AuthenticationOptionsPart()`          | `iam/auth/authentication-options.ts`                | A part of the authentication options.                |
| `@WhoAmIPart()`, `@SignInMethodsPart()` | `iam/auth/who-am-i.ts`                              | Keys of who-am-I and of the sign-in methods.         |
| `@SignInGate()`                         | `iam/auth/sign-in-gate.ts`                          | Whether a sign-in method may be used (SSO required). |
| `@AuthPolicySource()`                   | `iam/auth/auth-policy.ts`                           | The authentication policy in force.                  |
| `@HostTenantResolver()`                 | `iam/auth/host-tenant.ts`                           | The tenant of a custom domain.                       |
| `@BreakGlassGrantSource()`              | `iam/auth/break-glass-session.ts`                   | The grant a break-glass read uses.                   |
| `@ReauthenticationMethods()`            | `iam/auth/recent-authentication.ts`                 | Other ways to re-authenticate.                       |
| `@UnitDirectory()`                      | `iam/access/unit-directory.ts`                      | Organizational units for access rules.               |
| `@ScimMembers()`                        | `iam/access/scim-members.ts`                        | Which members SCIM manages.                          |
| `@ScimUnits()`                          | `iam/organization/scim-units.ts`                    | Which units SCIM manages.                            |
| `@AccessRecordFinder(subject)`          | `iam/access/access-record-finder.ts`                | The record behind an access explanation.             |
| `@ActorNameSource()`                    | `iam/audit/actor-names.ts`                          | Names for audit actors.                              |
| `@DomainChangeGuard()`                  | `iam/tenants/domain-change-guard.ts`                | Whether a tenant's domains may change.               |
| `@PersonalData(options)`                | `iam/personal-data/personal-data.ts`                | A section of the personal data export.               |
| `@RecordExtension()`                    | `modules/records/record-extension.ts`               | Hooks into a record's writes, views and lists.       |
| `@RecordPurge()`                        | `modules/retention/record-purge.ts`                 | Data to forget when records are deleted for good.    |
| `@ChoiceSource()`                       | `modules/choices/choices.registry.ts`               | A provider of dropdown choices.                      |
| `@SearchSource(subject)`                | `modules/search/search.source.ts`                   | A source of `GET /v1/search`.                        |
| `@InboxSourceOf(name)`                  | `modules/inbox/inbox.source.ts`                     | A source of the inbox.                               |
| `@Diagnostic(options)`                  | `modules/ops/ops.diagnostics.ts`                    | An integration operators can look at and test.       |
| `@AutomationAction(name)`               | `modules/automations/automation-actions.ts`         | An action of automation rules.                       |
| `@ApprovalEffect(options)`              | `modules/approvals/approvals.registry.ts`           | What happens once an action is approved.             |
| `@WebhookEvents()`                      | `modules/webhooks/webhook-events.ts`                | The webhook events a feature carries.                |
| `@OnIncomingWebhook(type, options)`     | `modules/webhooks/incoming-events.ts`               | The handler of an incoming webhook type.             |
| `@TransferColumns()`                    | `modules/data-transfer/data-transfer.columns.ts`    | Export and import columns of a record.               |
| `@BundleSection(name)`                  | `modules/config-bundles/config-bundles.sections.ts` | A section of the configuration bundle.               |

Route metadata works the same way in the other direction: a module marks a
route and a global guard reads the mark. Examples are `@AllowInMaintenance()`
(`core/http/maintenance.ts`, read by `modules/mode`), `@Captcha()`
(`iam/captcha`) and `@ReadOnlyPerCall()` (`modules/mode/mode.guard.ts`).

Some modules also take registrations through a static method of their own
module: `AccessModule.forFeature()` (permissions), `SettingsModule.forFeature()`,
`QuotasModule.forFeature()`, `WebhooksModule.forFeature()`,
`NotificationsModule.forFeature()`, `RetentionModule.forFeature()`,
`SequencesModule.forFeature()` and `ChoicesModule.forFeature()`. A feature lists
them in its own module.

**Domain events.** A module that would import one that already depends on it
publishes an event (`core/outbox/events.ts`):

- `defineEvent<Payload>('note.created')` names the event. The type is lowercase
  and dot-separated.
- `events.publish(event, payload)` runs inside the transaction of the change
  (`@Transactional()`; outside one it throws). The event is stored with the
  tenant, and it is delivered only if the change commits.
- `@OnDomainEvent(event, { consumer })` marks a method that runs in the worker,
  in the event's tenant. `consumer` names its inbox, so a redelivery runs it once.
- A record's events come from `recordEvents(declaration)`
  (`modules/records/record.events.ts`).

Details: [`core/outbox`](../apps/api/src/core/outbox/README.md). Realtime events
are declared where they are pushed with `defineRealtimeEvent()`
(`modules/realtime/realtime.events.ts`). `@nestjs/event-emitter` is only for
reactions inside the same request.

## The records engine

A feature is a record: nine files on the engine in `modules/records`. They are
`<item>.record.ts` (the declaration), `<items>.tables.ts`, `<item>.schemas.ts`,
`<item>.list.ts`, `<item>.permissions.ts`, `<item>.policy.ts`,
`<items>.service.ts`, `<items>.controller.ts` and `<items>.module.ts`. The engine
derives the table, schemas, list, permissions, policy and store from the
declaration, and it knows no add-on. An add-on (tags, comments, attachments,
sequences and the rest) is a module with `XModule.forRecord(DECLARATION)`,
listed in the feature's own module; it adds its routes and joins the record's
writes and views through a `@RecordExtension()` provider. The generator writes the
files: `pnpm feature:add` ([adding-a-feature.md](adding-a-feature.md)). The
contract, with "Writing a feature" and "Writing an add-on", is
[`modules/records/README.md`](../apps/api/src/modules/records/README.md).

## The processes

One build, four entry points in `apps/api/src`:

| File         | Command                                      | What it runs                                                                       |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `main.ts`    | `node dist/main` (`pnpm dev` in development) | The HTTP server, with the web app and sockets.                                     |
| `worker.ts`  | `node dist/worker`                           | The app as a plain application context: queue workers and scheduled jobs, no HTTP. |
| `migrate.ts` | `node dist/migrate`                          | The migrations, then the database roles and the tenant wall, once per deploy.      |
| `cli.ts`     | `pnpm ops <command>`                         | The operator CLI ([`cli`](../apps/api/src/cli/README.md)).                         |

`APP_ROLE` (`all`, `api` or `worker`, default `all`) decides whether a process
runs the queue workers and scheduled jobs. `worker.ts` sets `worker`, `cli.ts`
sets `api`. With `all`, one process does both, which suits development and small
deployments ([`core/queues`](../apps/api/src/core/queues/README.md)). `main.ts`
starts tracing first, builds the app with the HTTP adapter, applies the HTTP
conventions (`setupHttp`), attaches sockets (`setupRealtime`), serves the
OpenAPI document (`setupOpenApi`) and enables shutdown hooks.

## How a request flows

Order matters, so it is written down once, in `app.module.ts`.

1. **Before Nest's pipeline** (`setupHttp` in `core/http/http-setup.ts`): the
   request id (`X-Request-Id`, kept when it is safe to log, else a new UUID), the body parsers
   and their size limit, security headers, compression, CORS (when
   `CORS_ORIGINS` is set), CSRF protection and `/v1` versioning. The request log
   and the per-request context (`nestjs-cls`) are middleware.
2. **Global guards**, in the order their modules are listed in `app.module.ts`:
   1. The rate limit (`ThrottlingModule`, per address, counted in Redis).
   2. Who is calling (`AuthModule`): `PrincipalGuard` authenticates (401 unless
      the route is `@Public()`) and enters the principal's tenant; then
      `MfaEnrollmentGuard` and `OnboardingGuard`.
   3. What they may do (`AccessModule`, `@nestjs/authorization`): a route that
      declares no `@Can()`, `@Can.Anyone()` or `@Public()` is refused.
   4. Bot protection (`CaptchaModule`, routes marked `@Captcha()`), then "SSO
      required" (`SsoModule`), then the deployment mode (`ModeModule`:
      read-only and maintenance).

   Route-level guards (`@RecentAuthentication()`, `@OperatorOnly()`,
   `@UserThrottle()`) run after the global ones.

3. **Global interceptors**: idempotency first (`SharedIdempotencyModule`, on
   routes marked `@IdempotentRoute()`: a replayed response is neither metered nor
   retried), then usage metering (`UsageModule`: an API client over its daily
   quota gets 429), and the retries of outbound calls innermost
   (`SharedHttpClientModule`). The language (`I18nModule`) and the request
   context are the only two set outside idempotency.
4. **Pipe and handler**: Zod validation (`StandardSchemaValidationPipe`, global),
   then the controller, which does HTTP only, and the service, which owns the
   logic and its queries.
5. **Errors** leave as problem details (`ProblemDetailsFilter`), with the request id.

Guards run before interceptors, so the idempotency scope and the usage meter
see the caller. Each module's README says which of these it adds. See
[`core/http`](../apps/api/src/core/http/README.md),
[`iam/auth`](../apps/api/src/iam/auth/README.md) and
[`iam/access`](../apps/api/src/iam/access/README.md).

## Tenancy is a seam

Modules ask the tenancy module for the tenant's database and never know how
tenants are kept apart. Today the isolation is row-level security: every tenant
table is declared with `tenantTable()` and the database binds each query to the
current tenant, so code never filters by tenant. `TENANCY=single|multi` chooses
between one tenant and many. Every tenant table keeps `tenant_id` in every mode,
so a single-tenant project becomes multi-tenant by a switch, not a data
migration. Other isolation modes (schema or database per tenant) would sit
behind the same seam. See [`core/tenancy`](../apps/api/src/core/tenancy/README.md).
