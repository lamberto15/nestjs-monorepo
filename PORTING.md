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
- [x] database roles (app, owner, maintenance) and tenancy: row-level
      security behind one seam, `TENANCY=single|multi`, tenant-scoped jobs
- [x] mail: transports, queued delivery with retries
- [x] throttling (Redis counters, the multiplier)
- [x] metrics (`/metrics`) and observability (NestJS Observe, or OTLP to a
      self-hosted backend such as Nestrix)
- [x] secrets: keys the app makes for itself, made once and kept in the
      database (list cursors, file links, tokens, idempotency)
- [x] outbox and domain events, workflows, idempotency keys, outbound HTTP
      (timeouts, retries, circuit breaking), the job index
- [ ] mail delivery modes and budgets (with settings and quotas), maintenance
      mode (with settings), workflow payload encryption

## Identity and access (`apps/api/src/iam`)

- [x] auth: password sign-in, sessions, API keys, access tokens, the
      principal and its guards
- [ ] auth: token issue and refresh routes, impersonation, break-glass
- [ ] account (password, email, MFA, passkeys, sessions)
- [x] access: the permission catalog each module adds to, roles, dated
      grants, conditions, field permissions, the access API, the first-boot
      seed, the system principal
- [ ] access: API clients, invitations
- [x] organization (units, the tree, dated memberships, unit conditions)
- [x] audit (the log, sign-in entries, retention)
- [ ] audit: record changes and the audit pages
- [ ] sso (OIDC, SAML, SCIM)
- [x] captcha (Turnstile, the stub, app attestation)
- [ ] holds (legal holds)
- [ ] resources

## Modules (`apps/api/src/modules`)

- [ ] records, lists, fields, search, views
- [x] storage (local, S3, signed URLs), images, client-errors
- [x] money values (decimal arithmetic, currencies, columns), the expression
      language, field types
- [x] realtime (socket.io on Redis, sockets closed when a session, key,
      member or tenant ends), presence
- [ ] money routes and exchange rates
- [ ] tags, comments, attachments, revisions, favorites,
      recents, templates, choices, sequences, custom-fields
- [ ] approvals, acknowledgments, bulk, merge, data-transfer, reports,
      data-quality, retention
- [ ] notifications, messaging, inbox, subscriptions, deliverability,
      webhooks
- [ ] automations, forms, shares, ai, documents, calendars, recurrence,
      money
- [ ] settings, features, branding, quotas, usage, tenants, people,
      config-bundles, auth-policy, ops (dead letters, job admin), mode

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
- Sentry, and the monitoring and reporting database roles: errors go to the
  chosen observability backend.
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
- A permission condition is declared once, as column and value; the old
  template wrote each one twice (a CASL form and an SQL form).
- A module registers its permissions in its own imports
  (`AccessModule.forFeature()`); there is no list in a root module.
- No action may be named `manage` (CASL reads it as every action):
  `Approval.manage` and `Ops.manage` get another name when ported.
- `PATCH /access/users/:id` announces a deactivation as an event; sessions
  end on the member's next request.
- A route asks for bot protection with `@Captcha()`, metadata that the
  captcha module's global guard reads; it runs before a route's own limits
  (the old one ran after the sign-in limit).
- `GET /v1/auth/captcha` tells a page which widget to render (the old
  template put it in `/auth/methods`).
- Realtime events are declared where they are pushed; there is no central
  manifest and no `x-realtime-events` OpenAPI extension. Presence names a
  record type by its permission subject (`Note`), not a slug.
- Operators are the members of the tenant named by `OPERATOR_TENANT`
  (with `TENANCY=single`, of the one tenant); the tenants table has no
  operator column.
- Domain events have no fixed channels (webhook, notification, realtime):
  a module that delivers them subscribes with `@OnDomainEvent`.
