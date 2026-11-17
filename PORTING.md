# Porting status

Every capability of the earlier template, and whether it is here yet. A box is
ticked when the capability's behaviour and its e2e tests are in this
repository.

## Core (`apps/api/src/core`)

- [x] config: each module checks its own variables (`readEnv`, `*.config.ts`)
- [x] database: the connection (`@nestjs/drizzle`, node-postgres)
- [x] health: readiness and liveness (`@nestjs/terminus`)
- [x] config: `X_FILE` secrets, and `env.example` generated from the schemas
- [x] database: transactions that follow the call, shared columns, migrations
      at start and at deploy, error kinds, a database per e2e file
- [x] http: problem details, validation, versioning, security headers, CORS,
      CSRF, lists (filters, sorting, sealed cursors), ETags, OpenAPI
- [x] logging and redaction, the request log
- [x] redis, queues, the worker process, locks and scheduled jobs
- [x] encryption (data keys, blind indexes, re-encryption)
- [x] i18n (English; catalogs per module)
- [ ] database roles and tenancy (row-level security first)
- [ ] mail
- [ ] throttling, maintenance mode
- [ ] metrics and observability

## Identity and access (`apps/api/src/iam`)

- [ ] auth (sign-in, sessions, tokens)
- [ ] account (password, email, MFA, passkeys, sessions)
- [ ] access (roles, grants, conditions, field permissions, API clients)
- [ ] organization (units, memberships)
- [ ] audit
- [ ] sso (OIDC, SAML, SCIM)
- [ ] captcha
- [ ] holds (legal holds)
- [ ] resources

## Modules (`apps/api/src/modules`)

- [ ] records, lists, fields, search, views
- [ ] tags, comments, attachments, images, storage, revisions, favorites,
      recents, templates, choices, sequences, custom-fields, expressions
- [ ] approvals, acknowledgments, bulk, merge, data-transfer, reports,
      data-quality, retention
- [ ] notifications, messaging, inbox, subscriptions, deliverability,
      webhooks, realtime, events, presence
- [ ] automations, forms, shares, ai, documents, calendars, recurrence,
      money
- [ ] settings, features, branding, quotas, usage, tenants, people,
      integrations, config-bundles, idempotency, auth-policy, client-errors,
      ops, mode

## Features (`apps/api/src/features`)

- [ ] notes (the example)

## Around the API

- [ ] the typed client (`packages/api-client`)
- [ ] the web app (`apps/web`, `packages/ui`)
- [x] the worker process (`node dist/worker`)
- [ ] the operator CLI
- [ ] CI

## Not ported, on purpose

- The bundled operations stack (backups, monitoring, load tests, pgbouncer,
  PDF rendering service): a deployment's own.
- `analytics` (nightly aggregates for a reporting role): analytical
  reporting is done outside the app, in a store fed by replication. Scheduled
  exports (`reports`) stay, with data-transfer.

## Changed on the way

- A variable is described once, in its module's `*.config.ts`;
  `env.example` is generated from there (`pnpm env:example`).
- Readiness checks are contributed by the module that owns the dependency
  (`@ReadinessCheck()`), not listed in the health module.
- Every point in time is `timestamptz(3)` (`at()`), so no query truncates
  to the millisecond.
- A queue is registered by the module that owns it; there is no central
  list of queues.
- Without `CURSOR_KEYS` each process seals list cursors with its own key
  (the old template stored a generated key in the database).
